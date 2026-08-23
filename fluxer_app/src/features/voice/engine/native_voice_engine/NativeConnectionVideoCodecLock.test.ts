// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it} from 'vitest';
import {NativeConnectionVideoCodecLock} from './NativeConnectionVideoCodecLock';

describe('NativeConnectionVideoCodecLock', () => {
	it('locks to the first published codec and passes it through untouched', () => {
		const lock = new NativeConnectionVideoCodecLock();
		expect(lock.isLocked()).toBe(false);
		expect(lock.resolve('h264')).toEqual({codec: 'h264', overridden: false, locked: 'h264'});
		expect(lock.isLocked()).toBe(true);
		expect(lock.getLockedCodec()).toBe('h264');
	});

	it('overrides a later publish that asks for a different codec', () => {
		const lock = new NativeConnectionVideoCodecLock();
		lock.resolve('h264');
		expect(lock.resolve('vp8')).toEqual({codec: 'h264', overridden: true, locked: 'h264'});
		expect(lock.resolve('vp9')).toEqual({codec: 'h264', overridden: true, locked: 'h264'});
	});

	it('treats an unset codec as the sdk default and keeps it unset when it agrees with the lock', () => {
		const lock = new NativeConnectionVideoCodecLock();
		expect(lock.resolve(undefined)).toEqual({codec: undefined, overridden: false, locked: 'vp8'});
		expect(lock.resolve('vp8')).toEqual({codec: 'vp8', overridden: false, locked: 'vp8'});
		expect(lock.resolve('')).toEqual({codec: '', overridden: false, locked: 'vp8'});
		expect(lock.resolve('h264')).toEqual({codec: 'vp8', overridden: true, locked: 'vp8'});
	});

	it('substitutes the locked codec for an unset request once a real codec is locked', () => {
		const lock = new NativeConnectionVideoCodecLock();
		lock.resolve('h264');
		expect(lock.resolve(undefined)).toEqual({codec: 'h264', overridden: true, locked: 'h264'});
		expect(lock.resolve('')).toEqual({codec: 'h264', overridden: true, locked: 'h264'});
	});

	it('relocks after a reset, because the next connection negotiates from scratch', () => {
		const lock = new NativeConnectionVideoCodecLock();
		lock.resolve('h264');
		lock.reset();
		expect(lock.isLocked()).toBe(false);
		expect(lock.getLockedCodec()).toBeNull();
		expect(lock.resolve('vp9')).toEqual({codec: 'vp9', overridden: false, locked: 'vp9'});
	});

	it('is idempotent for repeated publishes of the locked codec', () => {
		const lock = new NativeConnectionVideoCodecLock();
		lock.resolve('vp9');
		for (let attempt = 0; attempt < 3; attempt++) {
			expect(lock.resolve('vp9')).toEqual({codec: 'vp9', overridden: false, locked: 'vp9'});
		}
	});
});
