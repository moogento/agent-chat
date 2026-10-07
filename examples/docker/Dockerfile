ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE}
WORKDIR /app
COPY agent-chat.mjs ./
COPY LICENSE ./
COPY lib/ ./lib/
COPY hooks/ ./hooks/
COPY integrations/ ./integrations/
RUN mkdir /data && chown node:node /data && chmod 700 /data
USER node
ENV AGENT_CHAT_HOME=/data
ENTRYPOINT ["node", "/app/agent-chat.mjs"]
CMD ["broker", "--host", "0.0.0.0", "--port", "47321", "--token-file", "/run/secrets/broker_token", "--home", "/data"]
