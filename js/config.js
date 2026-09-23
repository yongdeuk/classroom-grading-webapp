// 이 값들을 선생님의 Google Cloud 프로젝트 정보로 바꿔주세요. (README.md 설치 안내 참고)
const CONFIG = {
  // Google Cloud Console > API 및 서비스 > 사용자 인증 정보 에서 만든
  // "OAuth 클라이언트 ID"(유형: 웹 애플리케이션)의 클라이언트 ID
  CLIENT_ID: '788278406922-t2sjqhkttagrcn6hlnc1qgpasfo16fou.apps.googleusercontent.com',

  // 필요한 권한 범위. 채점 프로그램은 클래스룸·드라이브를 "읽기 전용"으로만 사용합니다.
  SCOPES: [
    'https://www.googleapis.com/auth/classroom.courses.readonly',
    'https://www.googleapis.com/auth/classroom.coursework.students.readonly',
    'https://www.googleapis.com/auth/classroom.rosters.readonly',
    'https://www.googleapis.com/auth/drive.readonly',
  ].join(' '),
};
