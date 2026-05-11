# Drama Wordbook Server

公网同步服务。建议部署在反向代理后面，只暴露 HTTPS：

```bash
cd apps/server
python3 -m venv .venv
. .venv/bin/activate
pip install -e .
uvicorn app.main:app --host 127.0.0.1 --port 18321
```

默认使用项目内的 SQLite 文件。生产环境建议配置 PostgreSQL：

```bash
export DATABASE_URL="postgresql+psycopg://drama_user:your-password@127.0.0.1:5432/drama_wordbook"
```

生产环境请使用 Caddy/Nginx/Traefik 终止 TLS，并把外部地址配置成 `https://your-domain`。桌面端对公网同步地址会拒绝明文 HTTP，只允许 `https://`，本机调试可用 `http://127.0.0.1` 或 `http://localhost`。

## 调试管理界面

服务端内置了一个仅用于调试的管理页，可查看用户哈希密码、盐值、登录 token 哈希、搭子申请和同步提交记录，并支持重置测试账号密码。

1. 启动前设置管理口令（可选，默认是 `drama-debug`）：

```bash
export DRAMA_ADMIN_TOKEN="your-admin-token"
```

2. 打开管理页：

```text
http://127.0.0.1:18321/admin?token=your-admin-token
```

说明：
- 密码是哈希存储，管理页不会显示明文密码（数据库里也没有明文）。
- 重置密码入口位于管理页顶部。
- 请勿在公网暴露该调试入口，建议只在内网或本机使用。
