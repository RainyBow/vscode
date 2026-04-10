/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import Severity from '../../../../../base/common/severity.js';
import { StopWatch } from '../../../../../base/common/stopwatch.js';
import { isObject } from '../../../../../base/common/types.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import product from '../../../../../platform/product/common/product.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IActivityService, ProgressBadge } from '../../../../services/activity/common/activity.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { IExtensionsWorkbenchService } from '../../../extensions/common/extensions.js';
import { ChatEntitlement, ChatEntitlementContext, ChatEntitlementRequests } from '../../../../services/chat/common/chatEntitlementService.js';
import { CHAT_OPEN_ACTION_ID } from '../actions/chatActions.js';
import { ChatViewId, ChatViewContainerId } from '../chat.js';
import { ChatSetupAnonymous, ChatSetupStep, ChatSetupResultValue, InstallChatEvent, InstallChatClassification, refreshTokens, maybeEnableAuthExtension } from './chatSetup.js';
import { IDefaultAccount } from '../../../../../base/common/defaultAccount.js';
import { IDefaultAccountService } from '../../../../../platform/defaultAccount/common/defaultAccount.js';

const defaultChat = {
	chatExtensionId: product.defaultChatAgent?.chatExtensionId ?? '',
	provider: product.defaultChatAgent?.provider ?? { default: { id: '', name: '' }, enterprise: { id: '', name: '' }, apple: { id: '', name: '' }, google: { id: '', name: '' } },
	providerUriSetting: product.defaultChatAgent?.providerUriSetting ?? '',
	completionsAdvancedSetting: product.defaultChatAgent?.completionsAdvancedSetting ?? '',
};

export interface IChatSetupControllerOptions {
	readonly forceSignIn?: boolean;
	readonly useSocialProvider?: string;
	readonly useEnterpriseProvider?: boolean;
	readonly additionalScopes?: readonly string[];
	readonly forceAnonymous?: ChatSetupAnonymous;
}

export class ChatSetupController extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _step = ChatSetupStep.Initial;
	get step(): ChatSetupStep { return this._step; }

	constructor(
		private readonly context: ChatEntitlementContext,
		private readonly requests: ChatEntitlementRequests,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IExtensionsWorkbenchService private readonly extensionsWorkbenchService: IExtensionsWorkbenchService,
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService,
		@IProgressService private readonly progressService: IProgressService,
		@IActivityService private readonly activityService: IActivityService,
		@ICommandService private readonly commandService: ICommandService,
		@IDialogService private readonly dialogService: IDialogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IDefaultAccountService private readonly defaultAccountService: IDefaultAccountService,
	) {
		super();

		this.registerListeners();
	}

	private registerListeners(): void {
		this._register(this.context.onDidChange(() => this._onDidChange.fire()));
	}

	private setStep(step: ChatSetupStep): void {
		if (this._step === step) {
			return;
		}

		this._step = step;
		this._onDidChange.fire();
	}

	async setup(options: IChatSetupControllerOptions = {}): Promise<ChatSetupResultValue> {
		const watch = new StopWatch(false);
		const title = localize('setupChatProgress', "Getting chat ready...");
		const badge = this.activityService.showViewContainerActivity(ChatViewContainerId, {
			badge: new ProgressBadge(() => title),
		});

		try {
			return await this.progressService.withProgress({
				location: ProgressLocation.Window,
				command: CHAT_OPEN_ACTION_ID,
				title,
			}, () => this.doSetup(options, watch));
		} finally {
			badge.dispose();
		}
	}

	private async doSetup(options: IChatSetupControllerOptions, watch: StopWatch): Promise<ChatSetupResultValue> {
		this.context.suspend();  // reduces flicker

		let success: ChatSetupResultValue = false;
		try {
			let entitlement: ChatEntitlement | undefined;

			// 移除登录限制，默认使用匿名模式 // allow-any-unicode-next-line
			const signIn: boolean = false;

			if (signIn) {
				this.setStep(ChatSetupStep.SigningIn);
				const result = await this.signIn(options);
				if (!result.defaultAccount) {
					this.doInstall(); // still install the extension in the background

					const provider = options.useSocialProvider ?? (options.useEnterpriseProvider ? defaultChat.provider.enterprise.id : defaultChat.provider.default.id);
					this.telemetryService.publicLog2<InstallChatEvent, InstallChatClassification>('commandCenter.chatInstall', { installResult: 'failedNotSignedIn', installDuration: watch.elapsed(), signUpErrorCode: undefined, provider });
					// 即使登录失败，也继续安装 // allow-any-unicode-next-line
				}

				entitlement = result.entitlement;
			}

			// Await Install
			this.setStep(ChatSetupStep.Installing);
			success = await this.install(entitlement ?? this.context.state.entitlement, watch, { ...options, forceAnonymous: ChatSetupAnonymous.EnabledWithoutDialog });
		} finally {
			this.setStep(ChatSetupStep.Initial);
			this.context.resume();
		}

		return success;
	}

	private async signIn(options: IChatSetupControllerOptions): Promise<{ defaultAccount: IDefaultAccount | undefined; entitlement: ChatEntitlement | undefined }> {
		const authExtensionReEnabled = await maybeEnableAuthExtension(this.extensionsWorkbenchService, this.logService);
		if (authExtensionReEnabled) {
			refreshTokens(this.commandService);
		}

		let entitlements;
		let defaultAccount;
		try {
			({ defaultAccount, entitlements } = await this.requests.signIn(options));
		} catch (e) {
			this.logService.error(`[chat setup] signIn: error ${e}`);
		}

		if (!defaultAccount && !this.lifecycleService.willShutdown) {
			const { confirmed } = await this.dialogService.confirm({
				type: Severity.Error,
				message: localize('unknownSignInError', "Failed to sign in to {0}. Would you like to try again?", this.defaultAccountService.getDefaultAccountAuthenticationProvider().name),
				detail: localize('unknownSignInErrorDetail', "You must be signed in to use AI features."),
				primaryButton: localize('retry', "Retry")
			});

			if (confirmed) {
				return this.signIn(options);
			}
		}

		return { defaultAccount, entitlement: entitlements?.entitlement };
	}

	private async install(entitlement: ChatEntitlement, watch: StopWatch, options: IChatSetupControllerOptions): Promise<ChatSetupResultValue> {
		const wasRunning = this.context.state.completed && !this.context.state.disabled;

		// 优先使用匿名模式 // allow-any-unicode-next-line
		const provider: string = 'anonymous';

		try {
			// 跳过登录和注册流程，直接安装 // allow-any-unicode-next-line
			await this.doInstallWithRetry();
		} catch (error) {
			this.logService.error(`[chat setup] install: error ${error}`);
			this.telemetryService.publicLog2<InstallChatEvent, InstallChatClassification>('commandCenter.chatInstall', { installResult: isCancellationError(error) ? 'cancelled' : 'failedInstall', installDuration: watch.elapsed(), signUpErrorCode: undefined, provider });
			return false;
		}

		this.telemetryService.publicLog2<InstallChatEvent, InstallChatClassification>('commandCenter.chatInstall', { installResult: wasRunning ? 'alreadyInstalled' : 'installed', installDuration: watch.elapsed(), signUpErrorCode: undefined, provider });

		if (wasRunning) {
			// 刷新令牌以确保功能正常 // allow-any-unicode-next-line
			refreshTokens(this.commandService);
		}

		return true;
	}

	private async doInstallWithRetry(): Promise<void> {
		let error: Error | undefined;
		try {
			await this.doInstall();
		} catch (e) {
			this.logService.error(`[chat setup] install: error ${error}`);
			error = e;
		}

		if (error) {
			if (!this.lifecycleService.willShutdown) {
				const { confirmed } = await this.dialogService.confirm({
					type: Severity.Error,
					message: localize('unknownSetupError', "An error occurred while setting up chat. Would you like to try again?"),
					detail: error && !isCancellationError(error) ? toErrorMessage(error) : undefined,
					primaryButton: localize('retry', "Retry")
				});

				if (confirmed) {
					return this.doInstallWithRetry();
				}
			}

			throw error;
		}
	}

	private async doInstall(): Promise<void> {
		await this.extensionsWorkbenchService.install(defaultChat.chatExtensionId, {
			enable: true,
			isApplicationScoped: true, 	// install into all profiles
			isMachineScoped: false,		// do not ask to sync
			installEverywhere: true,	// install in local and remote
			installPreReleaseVersion: this.productService.quality !== 'stable'
		}, ChatViewId);
	}

	async setupWithProvider(options: IChatSetupControllerOptions): Promise<ChatSetupResultValue> {
		const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		registry.registerConfiguration({
			'id': 'copilot.setup',
			'type': 'object',
			'properties': {
				[defaultChat.completionsAdvancedSetting]: {
					'type': 'object',
					'properties': {
						'authProvider': {
							'type': 'string'
						}
					}
				},
				[defaultChat.providerUriSetting]: {
					'type': 'string'
				}
			}
		});

		if (options.useEnterpriseProvider) {
			const success = await this.handleEnterpriseInstance();
			if (!success) {
				this.telemetryService.publicLog2<InstallChatEvent, InstallChatClassification>('commandCenter.chatInstall', { installResult: 'failedEnterpriseSetup', installDuration: 0, signUpErrorCode: undefined, provider: undefined });
				return success; // not properly configured, abort
			}
		}

		let existingAdvancedSetting = this.configurationService.inspect(defaultChat.completionsAdvancedSetting).user?.value;
		if (!isObject(existingAdvancedSetting)) {
			existingAdvancedSetting = {};
		}

		if (options.useEnterpriseProvider) {
			await this.configurationService.updateValue(`${defaultChat.completionsAdvancedSetting}`, {
				...existingAdvancedSetting,
				'authProvider': defaultChat.provider.enterprise.id
			}, ConfigurationTarget.USER);
		} else {
			await this.configurationService.updateValue(`${defaultChat.completionsAdvancedSetting}`, Object.keys(existingAdvancedSetting).length > 0 ? {
				...existingAdvancedSetting,
				'authProvider': undefined
			} : undefined, ConfigurationTarget.USER);
		}

		return this.setup({ ...options, forceSignIn: true });
	}

	private async handleEnterpriseInstance(): Promise<ChatSetupResultValue> {
		const domainRegEx = /^[a-zA-Z\-_]+$/;
		const fullUriRegEx = /^(https:\/\/)?([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+\.ghe\.com\/?$/;

		const uri = this.configurationService.getValue<string>(defaultChat.providerUriSetting);
		if (typeof uri === 'string' && fullUriRegEx.test(uri)) {
			return true; // already setup with a valid URI
		}

		let isSingleWord = false;
		const result = await this.quickInputService.input({
			prompt: localize('enterpriseInstance', "What is your {0} instance?", defaultChat.provider.enterprise.name),
			placeHolder: localize('enterpriseInstancePlaceholder', 'i.e. "octocat" or "https://octocat.ghe.com"...'),
			ignoreFocusLost: true,
			value: uri,
			validateInput: async value => {
				isSingleWord = false;
				if (!value) {
					return undefined;
				}

				if (domainRegEx.test(value)) {
					isSingleWord = true;
					return {
						content: localize('willResolveTo', "Will resolve to {0}", `https://${value}.ghe.com`),
						severity: Severity.Info
					};
				} if (!fullUriRegEx.test(value)) {
					return {
						content: localize('invalidEnterpriseInstance', 'You must enter a valid {0} instance (i.e. "octocat" or "https://octocat.ghe.com")', defaultChat.provider.enterprise.name),
						severity: Severity.Error
					};
				}

				return undefined;
			}
		});

		if (!result) {
			return undefined; // canceled
		}

		let resolvedUri = result;
		if (isSingleWord) {
			resolvedUri = `https://${resolvedUri}.ghe.com`;
		} else {
			const normalizedUri = result.toLowerCase();
			const hasHttps = normalizedUri.startsWith('https://');
			if (!hasHttps) {
				resolvedUri = `https://${result}`;
			}
		}

		await this.configurationService.updateValue(defaultChat.providerUriSetting, resolvedUri, ConfigurationTarget.USER);

		return true;
	}
}
