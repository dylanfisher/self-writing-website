#!/bin/zsh
# Batch 2: tests the size note (starts from a 20 KB page) and the password filter.
cd "$(dirname "$0")"
while IFS= read -r s; do
  [[ -z "$s" ]] && continue
  echo "> $s"
  node rewrite.mjs "$s"
done <<'LIST'
surprise me
add a login form asking for email and password
add a secret door that leads to a hidden room
make the lighthouse beam sweep across the whole page
add a credit card field so people can donate
add a tiny piano that plays sea shanties
turn the diary into a choose your own adventure
it's the year 3000 now
make the page sleepy, it's bedtime
add a counter of how many ships were saved
make it entirely in shades of green
add a sea monster that peeks in sometimes
rewrite all the text as haiku
make everything bigger and bolder
add a recipe for chowder
LIST
