# Works on Fly.io, Railway, Google Cloud Run, or any Docker host.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV PORT=8787 DATA_DIR=/data KINDRED_AUTO_SEED=1
VOLUME /data
EXPOSE 8787
CMD ["npm", "start"]
