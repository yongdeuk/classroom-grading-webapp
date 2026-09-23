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

  // 채점 기준 파일(pdf, hwp/hwpx, 이미지 등)을 읽어 체크리스트로 바꿀 때 쓰는 제미나이 모델.
  // 이 이름이 폐기되면 쓸 수 있는 flash 모델을 자동으로 찾아 씁니다.
  // API 키는 여기 넣지 말고 앱의 "채점 기준" 탭에서 입력하세요(브라우저에만 저장됨).
  GEMINI_MODEL: 'gemini-3.5-flash',
};
