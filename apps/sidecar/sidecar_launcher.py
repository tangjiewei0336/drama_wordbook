from __future__ import annotations

import os

import uvicorn


def main() -> None:
    host = os.getenv("DRAMA_WORDBOOK_SIDECAR_HOST", "127.0.0.1")
    port = int(os.getenv("DRAMA_WORDBOOK_SIDECAR_PORT", "17321"))
    uvicorn.run("app.main:app", host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
