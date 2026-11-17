"""P의 여행수첩 로컬 서버. 실행: python run.py  (브라우저에서 http://127.0.0.1:8000)"""

import uvicorn

from backend.config import settings


if __name__ == "__main__":
    print(f"P의 여행수첩: http://127.0.0.1:{settings.port}  (끄려면 Ctrl+C)")
    uvicorn.run("backend.main:app", host="127.0.0.1", port=settings.port)
