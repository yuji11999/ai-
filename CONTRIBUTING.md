# 开发与验证

## 环境与启动

- Windows 10/11 x64；建议使用 Node.js 24 和 npm。
- 在新的空工作目录执行 `npm ci` 安装锁定版本的依赖。`npm ci` 会清除已有 `node_modules`，在包含现有依赖的目录中执行前请先保留所需内容。
- `npm run dev:desktop` 构建主进程并启动桌面开发版。Vite 只监听 `127.0.0.1`，渲染代码支持热更新；主进程和预加载代码修改后需要重启。
- `npm start` 使用已经构建的代码启动 Electron。

## 检查

```powershell
npm run typecheck
node --import tsx --test src/renderer/*.test.ts tests/batch-template.test.ts tests/batch-references.test.ts tests/concurrency-limit.test.ts tests/output-settings.test.ts tests/reference-preview.test.ts tests/task-actions.test.ts
npx vite build --emptyOutDir false
node scripts/build-main.mjs
```

上面的测试使用内存或模拟服务，不发送真实生图请求。部分其他测试会创建并永久删除临时目录；在要求清理可恢复的环境中，先调整测试清理方式再运行完整的 `npm test`。默认的 `npm run build` 会清空 `dist`，需要保留既有构建产物时使用上面的命令。

真实供应商验证会产生网络请求，可能消耗额度，应使用经授权的测试账户与数据，并记录验证范围。

## 代码结构

- `src/main/`：Electron 主进程、任务队列、供应商接口、文件和凭据存储。
- `src/renderer/`：React 页面、组件、样式和界面逻辑。
- `src/shared/`：进程间共享类型及图片尺寸预设。
- `tests/`：队列、接口、文件、安全和集成测试。
- `scripts/`：开发启动、主进程构建与 Windows 打包辅助脚本。

## 提交前

检查 `git status`，确保只包含需要的源码和文档，不包含用户数据、Key、数据库、生成图片、日志或依赖缓存。不要根据测试样例推断真实接口已经验证。`VALIDATION.txt` 与 `SOURCE_SHA256.json` 保留原始交付信息，不能用作当前版本的测试或完整性证明。

开发版的凭据、任务数据库和参考图位于 `%APPDATA%/轻图-dev`，默认成图位于系统图片目录下的 `轻图`；这些路径在源码仓库之外。不要将它们复制进仓库。仓库已忽略本机认证配置、私钥、编辑器个人配置，以及根目录下约定的数据和导出目录；`.env.example` 等示例文件只能放占位符。可以用 `git check-ignore -v -- 路径` 核对某个文件是否被忽略，并用 `git diff --cached --name-only` 核对暂存文件。

忽略规则对已经跟踪的文件及 `git add -f` 无效，也不会从磁盘或已有历史中移除内容。Git 提交会包含作者姓名、邮箱；公开提交应使用 GitHub 提供的隐私邮箱。直接压缩整个工作目录时不会应用 `.gitignore`，分享源码应从 Git 中导出经过检查的版本。
