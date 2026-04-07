/*---------------------------------------------------------------------------------------------*
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { Event, Emitter } from '../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../base/common/lifecycle.js';
import { IStringDictionary } from '../../../base/common/collections.js';
import { ExtensionIdentifier } from '../../../platform/extensions/common/extensions.js';
import { IChatMessage, ILanguageModelChatMetadata, ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatProvider, ILanguageModelChatRequestOptions, ILanguageModelChatResponse, ILanguageModelChatInfoOptions } from './languageModels.js';
import { IRequestService } from '../../../platform/request/common/request.js';
import { ILogService } from '../../../platform/log/common/log.js';

/**
 * OPENAI兼容的语言模型提供商
 * 支持vllm等本地模型
 */
export class OpenAICompatibleLanguageModelProvider implements ILanguageModelChatProvider {

	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		@IRequestService private readonly _requestService: IRequestService,
		@ILogService private readonly _logService: ILogService
	) {
	}

	async provideLanguageModelChatInfo(options: ILanguageModelChatInfoOptions, token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		// 从配置中获取模型信息
		const configuration = options.configuration || {};
		const apiBaseUrl = configuration.apiBaseUrl as string || 'http://localhost:8000/v1';
		const apiKey = configuration.apiKey as string || 'empty';
		const models = configuration.models as string[] || ['gpt-3.5-turbo', 'gpt-4'];

		// 构建模型元数据
		return models.map(model => {
			return {
				identifier: `openai-compatible-${model}`,
				metadata: {
					extension: new ExtensionIdentifier('openai-compatible'),
					name: model,
					id: model,
					vendor: 'openai-compatible',
					version: '1.0',
					tooltip: `OpenAI compatible model: ${model}`,
					detail: `API Base: ${apiBaseUrl}`,
					family: 'openai-compatible',
					maxInputTokens: 4096,
					maxOutputTokens: 1024,
					isDefaultForLocation: {},
					isUserSelectable: true,
					capabilities: {
						vision: false,
						toolCalling: true,
						agentMode: true
					},
					configurationSchema: {
						type: 'object',
						properties: {
							apiBaseUrl: {
								type: 'string',
								title: 'API Base URL',
								description: 'The base URL for the OpenAI compatible API',
								default: 'http://localhost:8000/v1'
							},
							apiKey: {
								type: 'string',
								title: 'API Key',
								description: 'The API key for the OpenAI compatible API',
								default: 'empty',
								secret: true
							},
							models: {
								type: 'array',
								items: {
									type: 'string'
								},
								title: 'Models',
								description: 'List of available models',
								default: ['gpt-3.5-turbo', 'gpt-4']
							}
						}
					}
				}
			};
		});
	}

	async sendChatRequest(modelId: string, messages: IChatMessage[], from: ExtensionIdentifier | undefined, options: ILanguageModelChatRequestOptions, token: CancellationToken): Promise<ILanguageModelChatResponse> {
		// 从模型ID中提取模型名称
		const modelName = modelId.replace('openai-compatible-', '');

		// 获取配置
		const configuration = options.configuration || {};
		const apiBaseUrl = configuration.apiBaseUrl as string || 'http://localhost:8000/v1';
		const apiKey = configuration.apiKey as string || 'empty';

		// 构建请求数据
		const requestData = {
			model: modelName,
			messages: messages.map(msg => ({
				role: ['system', 'user', 'assistant'][msg.role],
				content: msg.content.map(part => {
					if (part.type === 'text') {
						return part.value;
					}
					// 处理其他类型的内容
					return JSON.stringify(part);
				}).join(' ')
			})),
			stream: true
		};

		// 发送请求
		const response = await this._requestService.request({
			type: 'POST',
			url: `${apiBaseUrl}/chat/completions`,
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`
			},
			data: requestData,
			followRedirects: 5,
			token
		});

		// 处理流式响应
		const stream = this._processStream(response);

		return {
			stream,
			result: Promise.resolve({})
		};
	}

	private async* _processStream(response: any): AsyncIterable<any> {
		if (!response.stream) {
			return;
		}

		const reader = response.stream.getReader();
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				// 解码并处理数据
				const chunk = new TextDecoder('utf-8').decode(value);
				buffer += chunk;

				// 处理SSE格式的数据
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (line.startsWith('data: ')) {
						const data = line.substring(6);
						if (data === '[DONE]') {
							return;
						}
						try {
							const json = JSON.parse(data);
							if (json.choices && json.choices.length > 0) {
								const choice = json.choices[0];
								if (choice.delta && choice.delta.content) {
									yield [{ type: 'text', value: choice.delta.content }];
								}
							}
						} catch (e) {
							this._logService.error(`Error parsing OpenAI response: ${e}`);
						}
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	async provideTokenCount(modelId: string, message: string | IChatMessage, token: CancellationToken): Promise<number> {
		// 简单的token计数实现
		if (typeof message === 'string') {
			return message.length / 4; // 粗略估计
		} else {
			const text = message.content.map(part => {
				if (part.type === 'text') {
					return part.value;
				}
				return '';
			}).join(' ');
			return text.length / 4;
		}
	}
}
