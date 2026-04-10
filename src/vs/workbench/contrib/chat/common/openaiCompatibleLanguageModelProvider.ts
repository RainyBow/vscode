/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event, Emitter } from '../../../../base/common/event.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IChatMessage, ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatProvider, ILanguageModelChatRequestOptions, ILanguageModelChatResponse, ILanguageModelChatInfoOptions, IChatResponsePart } from './languageModels.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import type { IRequestContext } from '../../../../base/parts/request/common/request.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { VSBuffer } from '../../../../base/common/buffer.js';

/**
 * OPENAI兼容的语言模型提供商 // allow-any-unicode-next-line
 * 支持vllm等本地模型 // allow-any-unicode-next-line
 */
export class OpenAICompatibleLanguageModelProvider implements ILanguageModelChatProvider {

	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		@IRequestService private readonly _requestService: IRequestService,
		@ILogService private readonly _logService: ILogService
	) {
	}

	async provideLanguageModelChatInfo(options: ILanguageModelChatInfoOptions): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		// 从配置中获取模型信息 // allow-any-unicode-next-line
		const configuration = options.configuration || {};
		const apiBaseUrl = configuration.apiBaseUrl as string || 'http://localhost:8000/v1';
		const models = configuration.models as string[] || ['gpt-3.5-turbo', 'gpt-4'];

		// 构建模型元数据 // allow-any-unicode-next-line
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
					modelPickerCategory: undefined,
					capabilities: {
						vision: false,
						toolCalling: true,
						agentMode: true
					}
				}
			};
		});
	}

	async sendChatRequest(modelId: string, messages: IChatMessage[], _from: ExtensionIdentifier | undefined, options: ILanguageModelChatRequestOptions, token: CancellationToken): Promise<ILanguageModelChatResponse> {
		// 从模型ID中提取模型名称 // allow-any-unicode-next-line
		const modelName = modelId.replace('openai-compatible-', '');

		// 获取配置 // allow-any-unicode-next-line
		const configuration = options.configuration || {};
		const apiBaseUrl = configuration.apiBaseUrl as string || 'http://localhost:8000/v1';
		const apiKey = configuration.apiKey as string || 'empty';

		// 构建请求数据 // allow-any-unicode-next-line
		const requestData = {
			model: modelName,
			messages: messages.map(msg => ({
				role: ['system', 'user', 'assistant'][msg.role],
				content: msg.content.map(part => {
					if (part.type === 'text') {
						return part.value;
					}
					// 处理其他类型的内容 // allow-any-unicode-next-line
					return JSON.stringify(part);
				}).join(' ')
			})),
			stream: true
		};

		// 发送请求 // allow-any-unicode-next-line
		const response = await this._requestService.request({
			type: 'POST',
			url: `${apiBaseUrl}/chat/completions`,
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`
			},
			data: JSON.stringify(requestData),
			followRedirects: 5,
			callSite: 'OpenAICompatibleLanguageModelProvider.sendChatRequest'
		}, token);

		// 处理流式响应 // allow-any-unicode-next-line
		const stream = this._processStream(response);

		return {
			stream,
			result: Promise.resolve({})
		};
	}

	private async* _processStream(response: IRequestContext): AsyncIterable<IChatResponsePart[]> {
		let buffer = '';

		try {
			// 监听流的事件 // allow-any-unicode-next-line
			const stream = response.stream;
			let isDone = false;

			// 使用 Promise 包装流的读取过程 // allow-any-unicode-next-line
			const readChunk = (): Promise<VSBuffer | null> => {
				return new Promise((resolve) => {
					const onData = (data: VSBuffer) => {
						stream.removeListener('data', onData);
						stream.removeListener('end', onEnd);
						stream.removeListener('error', onError);
						resolve(data);
					};

					const onEnd = () => {
						isDone = true;
						stream.removeListener('data', onData);
						stream.removeListener('end', onEnd);
						stream.removeListener('error', onError);
						resolve(null);
					};

					const onError = (error: Error) => {
						stream.removeListener('data', onData);
						stream.removeListener('end', onEnd);
						stream.removeListener('error', onError);
						this._logService.error(`Error reading stream: ${error}`);
						resolve(null);
					};

					stream.on('data', onData);
					stream.on('end', onEnd);
					stream.on('error', onError);
				});
			};

			// 读取并处理数据 // allow-any-unicode-next-line
			while (!isDone) {
				const chunk = await readChunk();
				if (!chunk) {
					break;
				}

				// 解码并处理数据 // allow-any-unicode-next-line
				const chunkString = chunk.toString();
				buffer += chunkString;

				// 处理SSE格式的数据 // allow-any-unicode-next-line
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
		} catch (e) {
			this._logService.error(`Error processing OpenAI stream: ${e}`);
		}
	}

	async provideTokenCount(_modelId: string, message: string | IChatMessage): Promise<number> {
		// 简单的token计数实现 // allow-any-unicode-next-line
		if (typeof message === 'string') {
			return message.length / 4; // 粗略估计 // allow-any-unicode-next-line
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
