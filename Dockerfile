# Dockerfile
FROM node:20-alpine

WORKDIR /app

# Instala apenas dependências de produção
COPY package*.json ./
RUN npm install --only=production

# Copia o resto do código
COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]