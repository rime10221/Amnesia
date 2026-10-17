# Amnesia 낱말카드

Quizlet 스타일의 낱말카드 암기 앱입니다. 설치 없이 브라우저에서 돌아가고, 안드로이드 크롬에서 **홈 화면에 추가**하면 일반 앱처럼 전체 화면으로 실행됩니다(PWA).

## 기능

- **낱말카드 학습**: 앞면만 보이고, 카드를 한 번 탭하면 즉시 뒷면이 나옵니다. 좌우 스와이프로 이전/다음, 모름/알았음 버튼으로 평가.
- **순서대로 / 섞어서**: 섞기는 매번 새로운 랜덤 시드를 사용합니다. 학습 중 메뉴(⋮)에서 남은 카드만 다시 섞거나, 시드를 직접 입력해 같은 순서를 재현할 수 있습니다.
- **범위 지정**: 1~N번 범위 입력, 또는 20/30/50/100개 묶음 버튼으로 바로 선택.
- **필터**: 전체 / 아직 못 외운 것 / 모름 표시만 / ★ 별표만. 학습이 끝나면 "모른 것만 다시" 버튼이 나옵니다.
- **뒷면부터 보기**: 뜻을 보고 단어를 떠올리는 역방향 학습.
- **직접 입력**: 세트 화면에서 앞면/뒷면 타이핑 후 추가. 카드 탭으로 편집, 삭제, 순서 이동.
- **대량 가져오기**: 엑셀(.xlsx), CSV, 텍스트 파일, 또는 붙여넣기(`단어 : 뜻`, `단어[Tab]뜻`, `단어 - 뜻`). 열 매핑 미리보기, 첫 행 제목 처리, 중복 건너뛰기, "과목" 같은 열로 세트 자동 분리.
- **엑셀 내보내기**: 세트 메뉴 → 엑셀로 내보내기.
- **구글 드라이브 동기화**: 내 드라이브의 `Amnesia/amnesia-decks.json` 한 파일에 모든 세트·카드·학습 기록을 저장하고, 여러 기기에서 카드 단위로 자동 병합합니다. 변경 후 몇 초 뒤, 그리고 앱을 열 때마다 동기화됩니다.
- **오프라인 동작**, 다크 모드, 키보드 단축키(Space 뒤집기, ←/→ 이동, 1 모름, 2 알았음).

## 배포 (GitHub Pages, 무료)

앱은 `app/` 폴더의 정적 파일 4개(index.html, app.js, styles.css, sw.js)와 아이콘뿐이라 어떤 정적 호스팅에도 올릴 수 있습니다. 구글 로그인은 **HTTPS 주소**가 필요하므로 GitHub Pages를 권장합니다.

1. GitHub에서 새 저장소를 만듭니다 (예: `amnesia`).
2. 이 `app` 폴더 내용을 올립니다.
   ```powershell
   cd <app 폴더 경로>
   git init
   git add .
   git commit -m "Amnesia flashcards"
   git branch -M main
   git remote add origin https://github.com/<내아이디>/amnesia.git
   git push -u origin main
   ```
3. 저장소 **Settings → Pages → Branch: main / (root)** 로 설정하면 몇 분 뒤 `https://<내아이디>.github.io/amnesia/` 에서 열립니다.

## 구글 드라이브 연동 설정 (최초 1회, 약 5분)

1. [Google Cloud Console](https://console.cloud.google.com/)에서 새 프로젝트를 만듭니다.
2. **API 및 서비스 → 라이브러리**에서 `Google Drive API`를 사용 설정합니다.
3. **OAuth 동의 화면**: 사용자 유형 "외부", 앱 이름 입력, 범위는 건너뛰고, **테스트 사용자**에 본인 Gmail을 추가합니다.
4. **사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID**: 유형 "웹 애플리케이션", **승인된 JavaScript 원본**에 배포 주소의 origin을 추가합니다 (예: `https://<내아이디>.github.io`). 리디렉션 URI는 필요 없습니다.
5. 생성된 클라이언트 ID(`xxxx.apps.googleusercontent.com`)를 앱의 **설정 → Google OAuth 클라이언트 ID**에 붙여넣고 **Google 로그인**을 누릅니다.

앱이 요청하는 권한은 `drive.file`(앱이 만든 파일만 접근)과 이메일 주소뿐입니다. 드라이브의 다른 파일은 읽지 않습니다. 같은 클라이언트 ID로 로그인한 모든 기기가 같은 파일을 공유합니다.

## 안드로이드에 설치

배포 주소를 크롬으로 열고 **메뉴(⋮) → 홈 화면에 추가** (또는 설정 화면의 "홈 화면에 앱 설치" 버튼). 안드로이드의 파일 선택 창에서는 구글 드라이브에 있는 엑셀 파일을 바로 고를 수 있습니다.

## 로컬에서 실행해 보기

```powershell
cd <app 폴더 경로>
python -m http.server 8765
```
브라우저에서 `http://127.0.0.1:8765/` 를 엽니다. (로컬 주소에서도 OAuth 원본에 `http://127.0.0.1:8765`를 추가하면 드라이브 동기화를 테스트할 수 있습니다.)

## 데이터 구조

- 기기 저장: `localStorage`의 `amnesia.data.v1` (세트/카드/학습 기록), `amnesia.settings.v1`, `amnesia.sessions.v1`(진행 중인 학습).
- 드라이브 파일: `{ decks: { id: { name, created, updated, cards: { id: { f, b, pos, updated, deleted? } } } }, progress: { deckId: { cardId: { k, s, u } } } }`
- 병합 규칙: 세트·카드·학습 기록 각각 `updated`/`u`가 더 최신인 쪽이 이깁니다. 삭제는 tombstone(`deleted: true`)으로 전파됩니다.
