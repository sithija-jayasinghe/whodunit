# Records docs/demo.gif, the demo at the top of the README.
#
#   npm run demo
#
# Needs vhs (brew install vhs). Builds a throwaway repo with the hand-test
# fixture, so it never touches this one, then records a real search.

Output docs/demo.gif

Require git
Require node

Set Shell "bash"
Set FontSize 18
Set Width 1100
Set Height 860
Set Padding 24
Set WindowBar Colorful
Set TypingSpeed 45ms

# Setup, off camera: `whodunit` runs this checkout's build, and the fixture is
# an agent-sized change with one broken function.
Hide
Type `W="$PWD/dist/cli.js"; whodunit() { node "$W" "$@"; }; bash test/make-fixture.sh /tmp/whodunit-demo big > /dev/null 2>&1; cd /tmp/whodunit-demo; export PS1="$ "; clear`
Enter
Sleep 2s
Show

# An agent changed a dozen files...
Type "git diff --shortstat"
Sleep 400ms
Enter
Sleep 1.5s

# ...and a test that passed is now red.
Type "node test.js"
Sleep 400ms
Enter
Sleep 2s

# Which change did it?
Type "whodunit -- node test.js"
Sleep 600ms
Enter

# The search takes about a second; hold on the answer.
Sleep 7s
