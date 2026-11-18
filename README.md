# Debugger View

在 VS Code 里沿 TypeScript 的静态调用链做单步讲解。不启动目标项目，也不读取运行时变量。

函数上方的 CodeLens 或编辑器右键选「开始单步讲解」。跳过、进入、跳出使用调试工具栏或命令。讲解在侧边栏「单步讲解」。

在设置里填 `vscode-debugger-view.baseURL`、`vscode-debugger-view.model` 和 `vscode-debugger-view.apiKey`。API Key 在设置页以密码显示，请求失败的提示会抹掉密钥。
