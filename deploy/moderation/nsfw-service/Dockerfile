FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/opt/hf

RUN pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

WORKDIR /app
COPY app.py /app/app.py

# Bake the weights into the image so the running container never needs the internet
# and a Hugging Face outage cannot take the scanner down.
RUN python -c "import timm; timm.create_model('hf_hub:Marqo/nsfw-image-detection-384', pretrained=True)" \
 && useradd --system --uid 10001 nsfw \
 && chown -R nsfw /opt/hf
USER nsfw
ENV HF_HUB_OFFLINE=1

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4).status == 200 else 1)"

CMD ["uvicorn", "app:build_default_app", "--factory", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
