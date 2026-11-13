FROM python:3.12-bookworm

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

RUN pip install --no-cache-dir "playwright>=1.50,<2" \
    && playwright install --with-deps chromium

WORKDIR /app

COPY resolver.py /app/resolver.py

CMD ["python", "/app/resolver.py"]
