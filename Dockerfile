# 1. Supabase 권장에 맞춰 최신 Node 20 버전으로 업데이트
FROM node:20-bullseye-slim

# 2. 리눅스 서버에 Ghostscript(PDF 압축 엔진)를 설치합니다.
RUN apt-get update && apt-get install -y ghostscript && rm -rf /var/lib/apt/lists/*

# 3. 작업 폴더 세팅 및 패키지 설치
WORKDIR /app
COPY package*.json ./
RUN npm install

# 4. 소스 코드 복사 및 실행
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
