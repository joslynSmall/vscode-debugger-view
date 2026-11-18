# Debugger View

AI 驱动的源码单步调用和讲解插件：结合静态调用链与 VS Code Debugger 单步语义，支持 **TypeScript**、**JavaScript** 和 **Python**，**不要求目标项目可编译或可运行**。

---

## 一、安装插件

### 方式 1：下载 GitHub Release 安装包（推荐）

1. 前往 [Releases 页面](https://github.com/joslynSmall/vscode-debugger-view/releases) 下载最新的 `vscode-debugger-view-*.vsix`。
2. 安装到 VS Code（任选一种方式）：
   - **图形界面**：在 VS Code 按 `Ctrl+Shift+P`（macOS 为 `Cmd+Shift+P`）-> 输入 `Extensions: Install from VSIX...` -> 选择刚下载的 `.vsix` 文件。
   - **命令行**：
     ```bash
     code --install-extension vscode-debugger-view-0.1.0.vsix --force
     ```

如果你在 Windows 上安装了 GitHub CLI（`gh`），后续可用一条命令拉取并更新到最新版：

```powershell
gh release download --repo joslynSmall/vscode-debugger-view --pattern "*.vsix" -O ext.vsix --clobber && code --install-extension ext.vsix --force
```

### 方式 2：从源码本地打包安装

```bash
git clone https://github.com/joslynSmall/vscode-debugger-view.git
cd vscode-debugger-view
npm install
npm run compile
npx @vscode/vsce package
code --install-extension vscode-debugger-view-*.vsix --force
```

---

## 二、配置讲解模型

安装完成后，打开 VS Code 设置（`Ctrl+,`），搜索 **`Debugger View`**，配置以下三项（支持任意 OpenAI 兼容接口）：

| 配置项 | 说明 |
| :--- | :--- |
| `vscode-debugger-view.baseURL` | OpenAI 兼容接口根地址，例如 `https://api.openai.com` |
| `vscode-debugger-view.model` | `chat/completions` 使用的模型名 |
| `vscode-debugger-view.apiKey` | 接口 API Key（设置页以密码显示，报错提示会自动抹除密钥） |

示例 `settings.json`：

```json
{
  "vscode-debugger-view.baseURL": "https://api.openai.com",
  "vscode-debugger-view.model": "gpt-4o-mini",
  "vscode-debugger-view.apiKey": "sk-..."
}
```

> **提示**：分析 Python 文件时，请确保 VS Code 中已安装并启用 Python 语言扩展（如 Microsoft Python / Pylance），用于提供 Call Hierarchy（调用层级）信息；TypeScript / JavaScript 由 VS Code 内置语言服务直接支持。

---

## 三、使用方式

### 1. 开始单步讲解

打开任意 `.ts`、`.js` 或 `.py` 源码文件，可通过以下任一方式开始：
- 点击函数或方法定义上方的 CodeLens：**`▶ 开始单步讲解`**；
- 将光标放在函数内，右键菜单选择 **「开始单步讲解」**；
- 在命令面板（`Ctrl+Shift+P`）运行 **「开始单步讲解」**。

启动后，VS Code 会自动弹出调试控制工具栏，并在左侧活动栏打开 **「单步讲解」** 侧边栏。

### 2. 单步控制

使用 VS Code 调试工具栏快捷键或命令面板即可像真调试一样沿着静态调用链单步阅读：

- **跳过（Step Over / `F10`）**：移动到当前函数内的下一个调用点。
- **进入（Step Into / `F11`）**：进入当前调用点的目标函数实现；若存在多个可能的实现，面板会先列出候选并按 AI 推荐排序，点击对应候选后进入。
- **跳出（Step Out / `Shift+F11`）**：返回上层调用者的调用点。

### 3. 第三方库、历史回看与追问

- **第三方库边界**：遇到 `node_modules`、`site-packages` 等第三方库调用时，跳过和进入默认停在调用点；如需查看实现，可在侧边栏点击或运行命令 **「手动进入第三方库」**。
- **历史回看**：侧边栏按倒序保留每一步的调用位置和讲解，可点击任意历史步骤回看（从历史步骤继续单步时会截断之后的旧分支）。
- **追问与重试**：在当前讲解面板下方可直接针对当前代码位置继续**追问**，或点击 **「重新请求讲解」**。
- **恢复上次会话**：重新打开工作区后，可在命令面板运行 **「恢复上次单步讲解」** 回到上次保存的调用栈与讲解记录。

---

## 四、本地开发与验证

```bash
npm install
npm test
```

> 本地运行 `npm test` 需确保系统 `python3` 环境已安装 `jedi`（`pip install jedi`），用于执行 Python 调用链验收测试；插件正常运行不依赖该测试包。
