FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/x-python
ENV PATH="/opt/x-python/bin:${PATH}"
RUN pip install --no-cache-dir --upgrade 'pip>=26.2' 'setuptools>=84.1.0'
WORKDIR /app
COPY requirements-x.txt ./
RUN pip install --no-cache-dir -r requirements-x.txt
COPY src ./src
COPY x_archive.py extract_x_archive.py x_history_worker.py ./
CMD ["node", "/app/src/x-watch.mjs"]
