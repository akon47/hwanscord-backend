# 환스코드 - 백엔드

hwanscord-backend 프로젝트는 hwanscord-frontend 프로젝트를 위해 만든 토이 프로젝트 입니다.

## 사용 기술
* Node.js 사용
* REST API 구현을 위해 express 사용
* 실시간 채팅과 WebRTC의 시그널링 서버를 위해 Socket.io 사용
* WebRTC의 turn 서버를 위해 coturn 사용
* 회원, 채팅메시지, 생성된 채널등을 저장하고 관리하기 위해 MongoDB 사용
* 로그인 처리를 위해 jsonwebtoken 사용
* 사용자의 온라인/오프라인 상태 관리를 위해 redis 사용
* mongoDB, redis, coturn, node.js 를 모두 도커로 동시에 관리하기 위해 docker-compose 사용

## 실행 방법

```sh
docker-compose up
```
