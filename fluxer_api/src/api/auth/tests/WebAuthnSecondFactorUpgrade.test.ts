// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: upstream #2857 made a passkey count as a second factor only when the account opts in,
// and stopped `verifyWebAuthnRegistration` from setting UserAuthenticatorTypes.WEBAUTHN. The login
// gate (`userHasMfa`) still reads that stored bit, so every account that registered a passkey under
// the old behaviour keeps its challenge: the bit is already persisted. These tests pin that upgrade
// property, so a later change cannot silently drop the second factor from those accounts.
import {
	createAuthHarness,
	createTestAccount,
	type LoginMfaResponse,
	loginUser,
} from '@app/api/auth/tests/AuthTestUtils';
import {
	createAuthenticationResponse,
	createSudoWebAuthnBody,
	createWebAuthnDevice,
	registerWebAuthnCredential,
	setWebAuthnTwoFactor,
	type WebAuthnAuthenticationOptions,
} from '@app/api/auth/tests/WebAuthnTestUtils';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {UserAuthenticatorTypes} from '@fluxer/constants/src/UserConstants';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

describe('WebAuthn second factor survives the opt-in change', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createAuthHarness();
	});
	beforeEach(async () => {
		await harness.reset();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	// An account holding the stored WEBAUTHN bit alongside a password is exactly the state every
	// pre-change passkey registration left behind, so this is the "existing user" case.
	it('still challenges an account whose stored authenticator types include webauthn', async () => {
		const account = await createTestAccount(harness);
		const device = createWebAuthnDevice();
		await registerWebAuthnCredential(harness, account.token, device, () => ({password: account.password}));
		const enabled = await setWebAuthnTwoFactor(harness, account.token, true, {password: account.password});
		expect(enabled.user.authenticator_types).toEqual([UserAuthenticatorTypes.WEBAUTHN]);

		const login = (await loginUser(harness, {
			email: account.email,
			password: account.password,
		})) as LoginMfaResponse;
		expect(login.mfa).toBe(true);
		expect(login.webauthn).toBe(true);
		expect(login.allowed_methods).toContain('webauthn');
	});

	it('lets that account complete the webauthn challenge and finish logging in', async () => {
		const account = await createTestAccount(harness);
		const device = createWebAuthnDevice();
		await registerWebAuthnCredential(harness, account.token, device, () => ({password: account.password}));
		await setWebAuthnTwoFactor(harness, account.token, true, {password: account.password});

		const login = (await loginUser(harness, {
			email: account.email,
			password: account.password,
		})) as LoginMfaResponse;
		const mfaOptions = await createBuilderWithoutAuth<WebAuthnAuthenticationOptions>(harness)
			.post('/auth/login/mfa/webauthn/authentication-options')
			.body({ticket: login.ticket})
			.execute();
		if (mfaOptions.rpId) {
			device.rpId = mfaOptions.rpId;
		}
		const completed = await createBuilderWithoutAuth<{token: string}>(harness)
			.post('/auth/login/mfa/webauthn')
			.body({
				response: createAuthenticationResponse(device, mfaOptions),
				challenge: mfaOptions.challenge,
				ticket: login.ticket,
			})
			.execute();
		expect(completed.token).toBeTruthy();
	});

	// The opt-in is a stored choice, so turning it off must stay off: nothing in the deploy path may
	// re-enable it behind the account's back.
	it('leaves an account that opted out without a webauthn challenge', async () => {
		const account = await createTestAccount(harness);
		const device = createWebAuthnDevice();
		await registerWebAuthnCredential(harness, account.token, device, () => ({password: account.password}));
		const enabled = await setWebAuthnTwoFactor(harness, account.token, true, {password: account.password});
		expect(enabled.user.authenticator_types).toEqual([UserAuthenticatorTypes.WEBAUTHN]);
		const sudoBody = await createSudoWebAuthnBody(harness, account.token, device);
		const disabled = await setWebAuthnTwoFactor(harness, account.token, false, sudoBody);
		expect(disabled.user.authenticator_types).toEqual([]);

		const login = await loginUser(harness, {email: account.email, password: account.password});
		expect('mfa' in login).toBe(false);
	});
});
