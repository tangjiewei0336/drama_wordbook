# Releases 开箱试用

以下为从 **GitHub Releases** 下载预构建安装包后的本地试用流程。若你参与开发或自行打包，产物目录见 `apps/desktop/release`。

---

## 下载

1. 打开本仓库的 **Releases** 页面，选择合适版本。
2. 按系统下载对应资源（常见命名示例，以实际发布文件为准）：
   - **macOS**：`.dmg` 或 `.zip`
   - **Windows**：`Setup .exe` 或 `.zip` 绿色包

---

## macOS

### 安装

- 若下载的是 **DMG**：打开映像，将 **UNI** 拖入 **应用程序 (Applications)**。
- 若下载的是 **ZIP**：解压后，将整个 `.app` 拖入 `/Applications`。

### 绕过隔离属性（未公证 / 本地试装）

首次从网络下载的应用会被 macOS 打上 **隔离（quarantine）** 标记，可能提示「无法打开」或仅能取消。开箱试用时可去掉隔离属性后再打开：

```bash
xattr -dr com.apple.quarantine "/Applications/UNI.app"
```

然后在「应用程序」中双击启动，或在终端：

```bash
open -a "UNI"
```

> **说明**：`xattr -dr …` 会递归清除该应用的隔离标记，适合**自测与内测包**。正式对外分发应使用 **Apple 公证（notarization）** 与有效开发者签名，终端用户一般无需执行上述命令。

### 若仍被拦截

- **系统设置 → 隐私与安全性**：在提示出现时选择「仍要打开」，或对该应用解除限制（随系统版本略有不同）。
- 确保应用完整路径为 `/Applications/UNI.app`（若你放在其他目录，请把上面命令中的路径改成实际路径）。

---

## Windows

### 安装或解压

- **安装包（.exe）**：按向导安装；若出现 **Microsoft Defender SmartScreen**「已保护你的电脑」，可选「更多信息」→「仍要运行」（内测/未签名包常见）。
- **ZIP 包**：解压到任意目录，运行其中的 `UNI.exe`。

### 代码签名

正式发布应在 CI/本机配置 Authenticode 证书后由 `electron-builder` 签名；未配置证书时构建日志会出现 `signing is skipped`，安装时更容易触发 SmartScreen 提示。

---

## 首次运行说明

- 桌面端会尝试连接本机 **Sidecar**（默认 `http://127.0.0.1:17321`）。发行包若已内置 Sidecar 可执行文件，应用会随主程序一同释放；若 Sidecar 未就绪，界面会显示离线或空数据，属预期行为。
- 详细开发与打包说明见：`apps/desktop/README.md`。
