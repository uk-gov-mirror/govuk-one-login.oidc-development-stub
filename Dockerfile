FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install tsx

COPY app.ts index.ts tsconfig.json ./
COPY consumer/ consumer/
COPY provider/ provider/

EXPOSE 9000

CMD ["npx", "tsx", "app.ts"]
