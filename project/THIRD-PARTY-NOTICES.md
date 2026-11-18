# Сторонние компоненты

Архив содержит исходники приложения и package-lock.json. Node.js, зависимости
npm и модели не включены; они устанавливаются отдельно. Лицензии установленных
пакетов находятся в соответствующих каталогах node_modules и должны сохраняться
при самостоятельной поставке готовой сборки или зависимостей.

Основные зависимости: React и React DOM (MIT), Express (MIT), cors (MIT),
dotenv (BSD-2-Clause), Vite и @vitejs/plugin-react (MIT), tsx (MIT),
TypeScript (Apache-2.0), пакеты @types (MIT).
Точный состав и версии зафиксированы в package-lock.json.

Фоновые PNG из рабочего проекта не имеют записанных сведений об авторстве и
разрешении на распространение, поэтому скрипт release-source.mjs их не копирует.
Права на модели регулируются отдельно их поставщиками. Собственный код проекта
распространяется по MIT (см. LICENSE); зависимости сохраняют свои лицензии.

Optional Node.js runtime: not bundled. Obtain it from https://nodejs.org/en/download and retain the entire official archive, including LICENSE and bundled third-party notices. The launcher also supports a compatible installed Node.js with npm.
