// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: restored after upstream #3035 deleted the multi-provider captcha. Only
// the two HTTP-verified providers need this interface; ALTCHA is verified in
// process by AltchaProvider and does not implement it. See docs/adr/0008.
export interface VerifyCaptchaParams {
	token: string;
	remoteIp?: string;
}

export type CaptchaProviderType = 'hcaptcha' | 'turnstile';

export interface ICaptchaProvider {
	readonly type: CaptchaProviderType;
	verify(params: VerifyCaptchaParams): Promise<boolean>;
}
