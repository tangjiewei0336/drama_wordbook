# Drama Wordbook Server

公网同步服务。建议部署在反向代理后面：

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

生产环境可使用 Caddy/Nginx/Traefik 转发。当前客户端支持 `http://` 与 `https://`，例如可直接使用 `http://146.56.195.192`。

### Nginx 纯 HTTP（无 TLS）示例

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name 146.56.195.192;

    location / {
        proxy_pass http://127.0.0.1:18321;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

部署后执行：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

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
- 注册接口要求邀请码（每个邀请码仅可使用一次），可用管理接口生成：
  - `POST /admin/invite-codes?token=your-admin-token`，请求体可传 `{ "code": "CUSTOMCODE" }`，不传则自动生成。
- 请勿在公网暴露该调试入口，建议只在内网或本机使用。
