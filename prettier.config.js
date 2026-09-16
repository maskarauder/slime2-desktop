export default {
	plugins: [
		'prettier-plugin-organize-imports',
		'prettier-plugin-jsdoc',
		'prettier-plugin-tailwindcss', // MUST be last to work
	],
	arrowParens: 'avoid',
	semi: true,
	singleQuote: true,
	jsxSingleQuote: true,
	tabWidth: 4,
	trailingComma: 'all',
	tailwindFunctions: ['clsx'],
	tailwindStylesheet: './src/styles.css',
	useTabs: true,
};
