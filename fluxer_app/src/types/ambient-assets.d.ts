// SPDX-License-Identifier: AGPL-3.0-or-later

declare module '*.css';

declare module '*.svg' {
	const url: string;
	export default url;
}

declare module '*.svg?react' {
	import type {FunctionComponent, SVGProps} from 'react';

	const ReactComponent: FunctionComponent<SVGProps<SVGSVGElement>>;
	export default ReactComponent;
}

declare module '*.png' {
	const url: string;
	export default url;
}

declare module '*.webp' {
	const url: string;
	export default url;
}

declare module '*.avif' {
	const url: string;
	export default url;
}

declare module '*.mp3' {
	const url: string;
	export default url;
}

declare module '*.ogg' {
	const url: string;
	export default url;
}

declare module '@arborium/*/grammar.js' {
	const grammar: unknown;
	export default grammar;
}

declare module '@arborium/*/grammar_bg.wasm' {
	const url: string;
	export default url;
}

declare module '@pkgs/markdown_parser/markdown_parser.wasm' {
	const url: string;
	export default url;
}

declare module '@arborium/arborium/arborium_host_bg.wasm' {
	const url: string;
	export default url;
}

declare module '@pkgs/libfluxcore/libfluxcore_bg.wasm' {
	const url: string;
	export default url;
}

declare module '@pkgs/libfluxwebp/libfluxwebp_bg.wasm' {
	const url: string;
	export default url;
}

declare module '@pkgs/libfluxwebp/libfluxwebp_simd_bg.wasm' {
	const url: string;
	export default url;
}

// Echowire: the ban modal plays bundled video (banned.mp4/.webm) instead of
// upstream hotlinks; these were declared in vite-env.d.ts before upstream merged
// the ambient declarations into this file.
declare module '*.mp4' {
	const url: string;
	export default url;
}

declare module '*.webm' {
	const url: string;
	export default url;
}
