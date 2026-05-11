from __future__ import annotations

import uvicorn

SIDECAR_HOST = "127.0.0.1"
SIDECAR_PORT = 17321


def main() -> None:
    uvicorn.run("app.main:app", host=SIDECAR_HOST, port=SIDECAR_PORT, log_level="info")


if __name__ == "__main__":
    main()
