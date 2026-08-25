FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install tsx

COPY tsconfig.json tsconfig.build.json ./

COPY app.ts index.ts tsconfig.json ./
COPY consumer/ consumer/
COPY provider/ provider/
COPY config.local.json ./

RUN npm run build

EXPOSE 9001

CMD ["npx", "tsx", "app.ts"]
