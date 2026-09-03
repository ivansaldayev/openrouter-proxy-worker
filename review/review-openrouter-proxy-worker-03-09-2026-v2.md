# Ревью openrouter-proxy-worker — повтор после правок, 03.09.2026 (~09:50 UTC)

Репо: https://github.com/ivansaldayev/openrouter-proxy-worker · HEAD `ef3b5e6` (14 коммитов)
Живой URL: https://openrouter-proxy-worker.ivan01march.workers.dev · `x-worker-version: ef3b5e6` — совпадает с HEAD
Токен принят, POST-путь проверен живьём.

## Вердикт

Технически сервис работает: версия совпадает с коммитом, `/dexa` и `/food` отвечают по делу, валидация, таймауты и фолбэк-логика на месте, тесты реальные (10, без сети). **Отправлять ссылку клиенту пока нельзя** — три блокера, каждый 15–30 минут:

1. `CLAUDE.md` в публичном репо (коммит `e1e57a4`).
2. Пример ответа в README не воспроизводится на задеплоенной версии.
3. `messages` из одного `system` проходит валидацию и уходит в модель пустым запросом.

## Что закрыто из прошлого ревью (проверено кодом и живьём)

`x-worker-version` = sha HEAD (`package.json` deploy с `--var`) · `Object.hasOwn` — `/constructor`, `/__proto__`, `/hasOwnProperty` → 404 · тесты заменены на 10 реальных · LICENSE MIT · README «Every POST…», `x-model` только у ответов модели · `AGENTS.md` удалён · `inkling-small:free` убран, `/dexa` → 200 · фолбэк на 402/403/404/429/5xx + таймаут 25 с + non-JSON + пустой/обрезанный ответ · try/catch на `upstream.json()` · upstream-ошибки → 502 с `upstream_status` · лимит тела 6 МБ (живьём 7,3 МБ → 413) · клиентский `system` отбрасывается (живьём «PWNED» не прошёл) · `{image}` без `text` → 200 с дефолтным промптом · комментарии на английском · prettier соблюдён · HEAD → 200 без тела, `GET /dexa/` → 200, `GET /zzz` → 404 · `console.log` есть · `wrangler.jsonc` вычищен · README: модель угроз, CORS, `check`-скрипт · `HTTP-Referer` → репо.

## Новые находки

### 1. `CLAUDE.md` в публичном репо — блокер
Файл-инструкция для Claude Code (5,9 КБ): «This file provides guidance to Claude Code…», «Commits on this repo carry a Co-Authored-By: Claude Opus 5 trailer», «the current production APP_TOKEN matches the local one», «directory name … is still my-first-worker», «Do not reintroduce string surgery on model output», «npm test # vitest, 14 tests» (тестов 10). Для клиента, который читает исходники, это документ о том, что инженерные решения принимал агент, плюс операционные детали и неверные цифры.

### 2. README «Example answer» не воспроизводится — блокер
Пример помечен «version `ff8360c`» и начинается с `### Understanding Your Scores` — результат regex-обрезки преамбулы из той версии. В `ef3b5e6` обрезка удалена («verbatim»), и живые ответы `/dexa` (2 из 2) начинаются с `"\n\nOf course. Here is a clear explanation…"`; все ответы `/food` — с `"\n\n"`. Инструкцию «never open with “Of course”» в системном промпте модель игнорирует. Клиент, повторив curl из README, получит не то, что в README.

### 3. `src/index.ts` L54–56 + L145: `messages` только из `system` → пустой запрос в модель — блокер
`filter()` возвращает `[]`, `[]` truthy, проверка `if (!userMessages)` не срабатывает. Живьём `{"messages":[{"role":"system","content":"…"}]}` → 200 за 10,1 с, ответ «Please provide a photo or description of the meal.», 844 completion-токенов впустую. Должно быть 400. Сообщения с мусорными `role`/`content` тоже уходят в OpenRouter как есть и возвращаются как 502 вместо 400.

### 4. `reasoning.effort: 'low'` не действует на dots-3 (L170)
Reasoning-токены 153–1023 при `max_tokens` 1500; два ответа из восьми были в 20–43 токенах от `finish_reason: length`. При обрезке текстового запроса сработает фолбэк на nemotron (живьём не проверен); при запросе с картинкой кандидат один → 502 «All models unavailable».

### 5. Латентность против README
`/dexa` 8,3 и 11,1 с; `/food` 4,0–15,2 с (серия из 3 параллельных — 15,2 с). README обещает «3–8 s» — не выполняется на половине запросов.

### 6. Фолбэк ни разу не сработал живьём
Во всех 11 POST-ответах `fallbacks_tried: []`; ветки 402/403/429/timeout/length живым трафиком не проверены. 429 не появился ни разу (~14 вызовов dots-3 за 15 минут, 3 параллельно).

### 7. История коммитов
`86624b2` ужесточить промпт → `347fdac` regex-обрезка → `ff8360c` расширить regex → `ef3b5e6` убрать regex — за 40 минут решение менялось трижды, итоговое «verbatim» проблему преамбулы не решает. Все 14 коммитов с трейлером `Co-Authored-By: Claude Opus 5`.

### 8. Мелочи
`package.json` `deploy` с `$(git rev-parse …)` не работает в cmd/PowerShell. `wrangler.jsonc`: висячая запятая в `observability`. Сравнение токена `!==` не constant-time (nit).

## Качество ответов (содержание)

`/dexa` (2 вызова): T-score −2.6 → «osteoporosis range» со ссылкой на ВОЗ и порог −2.5; Z-score −1.8 → «normal for age»; вопросы врачу; дисклеймер. Лекарств не рекомендует, диагноза от первого лица нет. Полная таблица ВОЗ (норма ≥ −1, остеопения −1…−2.5) — во 2-м ответе есть, в 1-м нет. Преамбула «Of course…» в обоих.
`/food` (5 вызовов): структура «items + portions → kcal/protein/carbs/fat/calcium → estimates» во всех; преамбулы «Of course» нет, одно «Here is a nutritional estimate…», везде `\n\n` в начале.
Картинка: 1×1 PNG → «completely blank… solid white», 3,6 с; image-only → корректный отказ считать нутриенты.

## Задачи исполнителю, по приоритету

**P0 — до отправки отклика**
1. `git rm CLAUDE.md`; добавить `CLAUDE.md` и `CLAUDE.local.md` в `.gitignore`; инструкции для агента держать локально. Закоммитить и **передеплоить** (`npm run deploy`), иначе `x-worker-version` отстанет от HEAD.
2. `src/index.ts` `toMessages()`: после фильтра `user/assistant` возвращать `null`, если массив пуст; валидировать каждое сообщение (`role ∈ {user, assistant}`, `content` — строка или массив частей с `type ∈ {text, image_url}` и корректной формой), иначе 400. Unit-тест: `{"messages":[{"role":"system","content":"x"}]}` → 400; `{"messages":[{"role":"user","content":42}]}` → 400.
3. README «Example answer»: перегенерировать с текущего HEAD после п.1–2, вставить ответ как есть (включая `\n\n` и преамбулу, если осталась) и указать актуальный sha. Либо вернуть более жёсткую инструкцию в системный промпт и проверить тремя вызовами, что преамбула ушла; либо честно написать в README, что модель иногда начинает с «Of course».
4. README «take 3–8 s» → измеренный диапазон (4–15 с) или убрать цифры.

**P1 — желательно до отправки**
5. Reasoning-бюджет: убрать `effort: 'low'` как неработающий для dots-3 (оставить `exclude: true`), поднять `maxTokens` до 2500 или ввести в конфиг фичи `reasoningBudget`; проверить `finish_reason` на 5 подряд «Two eggs and toast».
6. Один раз проверить фолбэк живьём: временно поставить первым несуществующий id (`test/nonexistent:free`), выполнить `POST /food`, убедиться в `fallbacks_tried: [{"model":…,"status":404,…}]`, вернуть конфиг; снимок ответа — в README.
7. Решить с трейлерами `Co-Authored-By` во всех 14 коммитах: либо оставить и добавить в README одну строку про AI-assisted workflow, либо переписать историю (`git rebase -i --root`, `--force-with-lease`) до отправки ссылки.
8. 502 «Upstream error»: добавить в тело безопасную выжимку `data.error.message` (без ключей/URL).

**P2 — после**
9. Тесты: `Content-Type` ответов; отсутствие `x-model` в 401/404.
10. `deploy`-скрипт: кроссплатформенный (`node -e` для sha) или пометка «POSIX shell» в README.
11. `wrangler.jsonc`: убрать висячую запятую.
12. Сравнение токена через `crypto.subtle.timingSafeEqual` (nit).
