import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.js'],
    // 用真实的雨课堂域名跑 jsdom，让脚本内的 hostname 判断走"真"分支
    environment: 'jsdom',
    environmentOptions: {
      jsdom: { url: 'https://scut.yuketang.cn/' },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['yuketang-auto.user.js'],
      exclude: ['**/node_modules/**', '**/*.config.*', 'tests/**'],
    },
  },
})
