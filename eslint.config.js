import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['dist/**', 'android/**', 'node_modules/**'] },
  {
    files: ['**/*.{js,mjs,ts,vue}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        // 构建期由 vite.config.ts 的 define 注入，不是运行时变量
        __APP_VERSION__: 'readonly',
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },
  {
    rules: {
      // The project follows WeRead's component naming, not a linter's.
      'vue/multi-word-component-names': 'off',
      // Payload rows and plugin bridges are dynamic by nature.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // The codebase uses escaped delimiter classes in CJK regexes and
      // initialises values that are only read on some branches; both are
      // intentional, and the rules add noise without catching real defects.
      'no-useless-escape': 'off',
      'no-useless-assignment': 'off',
    },
  },
  prettier,
)
