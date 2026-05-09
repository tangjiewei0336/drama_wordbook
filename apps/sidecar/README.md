# Sidecar POC 启动说明

## 1. 安装依赖

在 `apps/sidecar` 目录执行：

```bash
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -U pip
pip install -e .
```

## 2. 启动服务

```bash
uvicorn app.main:app --host 127.0.0.1 --port 17321 --reload
```

## 3. 检查服务

打开浏览器访问：

- `http://127.0.0.1:17321/health`
- `http://127.0.0.1:17321/docs`

## 4. 目前接口

- `GET /health`
- `POST /ocr/recognize`
- `POST /ja/tokenize`
- `POST /playback/context`
- `GET /playback/context/{context_id}`

> 说明：这是试验版本。`/playback/context` 当前是内存存储，重启后会清空。
