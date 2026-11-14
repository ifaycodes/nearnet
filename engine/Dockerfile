FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv

COPY requirements-enclave.txt .
RUN pip install --no-cache-dir -r requirements-enclave.txt

COPY app ./app

EXPOSE 8000
# Runs as root on purpose for now: it must read the dstack guest-agent socket.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]