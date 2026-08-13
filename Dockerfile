FROM node:18
WORKDIR /app
ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}
ENV HUSKY=0
COPY package*.json ./
RUN if [ "$NODE_ENV" = "production" ]; then npm install --omit=dev; else npm install; fi
COPY . .
EXPOSE 3000
CMD ["node", "./src/server.js"]