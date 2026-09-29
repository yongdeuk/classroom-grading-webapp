// Google Identity Services(GIS) 토큰 클라이언트를 이용한 로그인/로그아웃.
// 서버 없이 브라우저에서만 동작하며, 액세스 토큰은 메모리에만 둔다(새로고침하면 다시 로그인).
const Auth = (() => {
  let tokenClient = null;
  let accessToken = null;
  let tokenExpiresAt = 0;
  let onChange = () => {};
  let lastResp = null; // 권한(scope) 확인용 마지막 토큰 응답

  function init(onChangeCb) {
    onChange = onChangeCb || onChange;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.CLIENT_ID,
      scope: CONFIG.SCOPES,
      callback: (resp) => {
        if (resp.error) { onChange({ error: resp.error }); return; }
        lastResp = resp;
        accessToken = resp.access_token;
        tokenExpiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000 - 30000;
        onChange({ token: accessToken });
      },
    });
  }

  function signIn() {
    tokenClient.requestAccessToken({ prompt: '' });
  }

  function signOut() {
    if (accessToken) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null;
    tokenExpiresAt = 0;
    onChange({ token: null });
  }

  function getToken() {
    return accessToken;
  }

  function isSignedIn() {
    return !!accessToken && Date.now() < tokenExpiresAt;
  }

  // 토큰 만료가 임박하면 조용히(팝업 없이) 갱신을 시도한다.
  async function ensureFreshToken() {
    if (isSignedIn()) return accessToken;
    return new Promise((resolve) => {
      const prevCb = tokenClient.callback;
      tokenClient.callback = (resp) => {
        tokenClient.callback = prevCb;
        if (resp.error) { resolve(null); return; }
        lastResp = resp;
        accessToken = resp.access_token;
        tokenExpiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000 - 30000;
        onChange({ token: accessToken });
        resolve(accessToken);
      };
      tokenClient.requestAccessToken({ prompt: '' });
    });
  }

  // 평소엔 읽기 전용 권한만 쓰고, 댓글 달기처럼 쓰기가 필요한 기능을 처음 쓸 때만 권한을 추가로 요청한다.
  // (동의 창이 한 번 뜬다. 이후 토큰 갱신 때도 이미 허락한 권한이 함께 유지된다)
  function hasScope(scope) {
    return !!lastResp && google.accounts.oauth2.hasGrantedAllScopes(lastResp, scope);
  }
  function ensureScope(scope) {
    if (hasScope(scope)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const prevCb = tokenClient.callback;
      tokenClient.callback = (resp) => {
        tokenClient.callback = prevCb;
        if (resp.error) { resolve(false); return; }
        lastResp = resp;
        accessToken = resp.access_token;
        tokenExpiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000 - 30000;
        resolve(google.accounts.oauth2.hasGrantedAllScopes(resp, scope));
      };
      tokenClient.requestAccessToken({ scope: CONFIG.SCOPES + ' ' + scope, prompt: 'consent' });
    });
  }

  return { init, signIn, signOut, getToken, isSignedIn, ensureFreshToken, hasScope, ensureScope };
})();
