# 网球成长记录

一个中文网球成长记录网站，包含账户、比赛比分、表情满意度、赛后复盘、月度趋势、比赛日历、SMART 目标和训练建议。

## 本地运行

```bash
.venv/bin/python server.py
```

然后打开 `http://127.0.0.1:4173`。第一次使用请先点击“创建账户”，之后使用自己注册的邮箱和密码登录。

## 连接 JSONBin

网站支持把账户、比赛、目标、训练建议和动作分析报告同步到一个私有 JSONBin，并同时在 `data/tennis.db` 保留 SQLite 备份。JSONBin 暂时断线时仍可读取本机备份；下次修改数据时会再次尝试同步。

1. 在 JSONBin 创建一个 Private Bin，初始内容填写 `{}`。
2. 创建一个只允许 `Bins Read` 与 `Bins Update` 的 Access Key。
3. 复制 `.env.example` 为 `.env`，填写 `JSONBIN_BIN_ID` 和 `JSONBIN_ACCESS_KEY`。
4. 重新启动 `server.py`。登录后，左下角会显示“JSONBin 已同步”。

密钥只由 Python 后端读取，不会出现在浏览器代码或网络响应中。请不要提交或分享 `.env`。

比赛视频分析使用项目本地安装的 MediaPipe 与 OpenCV。系统会先识别球员，多人时让用户确认目标球员，再分析整段视频并保存问题截图；视频不会发送到外部服务。

视频原文件和分析截图体积较大，继续保存在本机 `data/` 目录；JSONBin 同步的是它们的报告、名称和文件路径，不上传视频二进制内容。
