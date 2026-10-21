// hwanscord-backend CI/CD — same shape as visit-counter/funcia:
//   GitHub push (master) → Jenkins (build.kimhwan.kr) → lint/typecheck/tests inside `docker build --target test`
//   → image → Docker Hub (akon47/hwanscord-backend) → ssh deploy@10.10.10.75 → docker compose pull/up → smoke test.
pipeline {
    agent any

    options {
        disableConcurrentBuilds()
        timestamps()
        buildDiscarder(logRotator(numToKeepStr: '30'))
    }

    triggers {
        githubPush()
    }

    parameters {
        booleanParam(name: 'SKIP_DEPLOY', defaultValue: false, description: '빌드·푸시만 하고 배포는 건너뜀')
    }

    environment {
        IMAGE                 = 'akon47/hwanscord-backend'
        TAG                   = "${env.BUILD_NUMBER}"
        GITHUB_CREDENTIALS_ID = 'git-hub'
        DOCKER_CREDENTIALS_ID = 'docker-hub'
        SSH_CREDENTIALS_ID    = 'hwanscord-deploy'
        DEPLOY_HOST           = 'deploy@10.10.10.75'
        DEPLOY_DIR            = '/srv/hwanscord/backend'
        SSH_OPTS              = '-o StrictHostKeyChecking=no -o ConnectTimeout=15'
        HEALTH_URL            = 'http://10.10.10.75:8080/healthz'
    }

    stages {
        stage('Clone') {
            steps {
                git url: 'git@github.com:akon47/hwanscord-backend.git', branch: 'master', credentialsId: GITHUB_CREDENTIALS_ID, changelog: true
            }
        }

        stage('Test') {
            steps {
                // lint + typecheck run in the image build; vitest runs in a container next to a mongo:4.4 sidecar
                // (the Jenkins VM CPU has no AVX, which MongoDB 5+ and mongodb-memory-server's 7.x binary need;
                // the snap Docker on this VM cannot bind-mount the workspace, so nothing is mounted).
                sh '''
                    docker build --pull --target test -t hwanscord-backend-test:${TAG} .
                    docker network create hwanscord-ci-${TAG}
                    docker run -d --rm --name hwanscord-ci-mongo-${TAG} --network hwanscord-ci-${TAG} mongo:4.4
                    for i in $(seq 1 30); do
                        docker exec hwanscord-ci-mongo-${TAG} mongo --quiet --eval 'db.adminCommand("ping").ok' >/dev/null 2>&1 && break
                        sleep 2
                    done
                    docker run --rm --network hwanscord-ci-${TAG}                         -e TEST_MONGODB_URI=mongodb://hwanscord-ci-mongo-${TAG}:27017                         hwanscord-backend-test:${TAG}
                '''
            }
            post {
                always {
                    sh '''
                        docker rm -f hwanscord-ci-mongo-${TAG} >/dev/null 2>&1 || true
                        docker network rm hwanscord-ci-${TAG} >/dev/null 2>&1 || true
                        docker rmi hwanscord-backend-test:${TAG} >/dev/null 2>&1 || true
                    '''
                }
            }
        }

        stage('Build image') {
            steps {
                sh 'docker build --target runtime --build-arg APP_VERSION=${TAG} -t ${IMAGE}:${TAG} -t ${IMAGE}:latest .'
            }
        }

        stage('Push') {
            steps {
                withCredentials([usernamePassword(credentialsId: DOCKER_CREDENTIALS_ID, usernameVariable: 'DH_USER', passwordVariable: 'DH_PASS')]) {
                    sh '''
                        echo "$DH_PASS" | docker login -u "$DH_USER" --password-stdin
                        docker push ${IMAGE}:${TAG}
                        docker push ${IMAGE}:latest
                        docker logout
                    '''
                }
            }
        }

        stage('Deploy') {
            when { expression { !params.SKIP_DEPLOY } }
            steps {
                sshagent(credentials: [SSH_CREDENTIALS_ID]) {
                    sh '''
                        ssh ${SSH_OPTS} ${DEPLOY_HOST} "mkdir -p ${DEPLOY_DIR}"
                        tar -C deploy -cf - . | ssh ${SSH_OPTS} ${DEPLOY_HOST} "tar -C ${DEPLOY_DIR} -xmf -"
                        ssh ${SSH_OPTS} ${DEPLOY_HOST} "cd ${DEPLOY_DIR} && chmod +x deploy.sh backup.sh migrate-from-v1.sh && APP_TAG=${TAG} ./deploy.sh"
                    '''
                }
            }
        }

        stage('Smoke test') {
            when { expression { !params.SKIP_DEPLOY } }
            steps {
                sh '''
                    body=$(curl -fsS --max-time 20 ${HEALTH_URL})
                    echo "$body"
                    echo "$body" | grep -q "\\"version\\":\\"${TAG}\\"" || { echo "deployed version mismatch"; exit 1; }
                '''
            }
        }
    }

    post {
        always {
            sh 'docker image prune -f >/dev/null 2>&1 || true'
        }
    }
}
