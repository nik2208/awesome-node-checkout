FROM node:lts-bookworm-slim
WORKDIR /home/src/app 

COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
CMD ["node", "--env-file=.env", "dist/index.js"]
