#!/usr/bin/env bash
# Prepara o site para publicar no GitHub Pages. Roda sozinho em toda publicação
# (.github/workflows/publicar-site.yml), mas também pode ser rodado à mão.
#
# 1. O 404.html da raiz vira cópia exata do app/index.html. O GitHub Pages entrega o 404.html
#    da raiz em todo endereço que não é um arquivo (recarregar em /app/termos, abrir /app/cupom/123).
#    Se ele apontar para arquivos de uma versão antiga do app, a tela fica branca.
# 2. Confere se cada arquivo /app/... citado no app/index.html existe. Se faltar algum,
#    para com erro e o site NÃO é publicado (fica no ar a versão anterior).
set -euo pipefail
cd "$(dirname "$0")/.."

cp app/index.html 404.html

faltando=0
for ref in $(grep -oE '(src|href)="/app/[^"?#]+' app/index.html | sed -E 's/^(src|href)="\///'); do
  if [ ! -f "$ref" ]; then
    echo "FALTA: /$ref (citado em app/index.html)"
    faltando=1
  fi
done
if [ "$faltando" = 1 ]; then
  echo "Site incompleto: nada foi publicado. Copie de novo a versão web inteira para a pasta app/."
  exit 1
fi
echo "404.html = cópia de app/index.html; todos os arquivos citados existem."
