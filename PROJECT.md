## Problem statement:

Developers face a pain point with E2E web session recordings:
- They have to reproduce a bug inside a ticket, but the reproduction video is either missing, or unclear.
- They have to share a video after finishing a task to prove their changes fix the bug, meaning they have to manually record a journey that demonstrates them fixing the problem they tackled.


## Solution

A tool that uses technology similar to Sentry, Hotjar or `trace.playwright.dev` (`rrweb` like) to record a web session and offer the option of playing it back.

It is mainly 2 parts:
- Record and stop recording on demand.
- Replay and share your recording with others (ideally through web links)

I imagine 2 user journeys:
- Developer receives a bug, they launch their coding agent with a specific prompt that guides them to reproduce a bug, once they accurately reproduce it they start the tool to record, then stop the tool once done, then notify the user and give them the recording URL so they can view themselves.
- Developer finishes work, they tell their coding agent to produce a recording verifying the bug is fixed, they finish doing that and then share the link with the developer and the developer can use that link to share with others, update their ticket, etc...

The reason this works so well is, unlike a normal video recording, we can speed up the parts (through something like idle detectionc) where a coding agent takes long to think about the browser interaction they are doing in playwright, so user doesnt have to sit through a long recording of long periods of idleness.


## Planning

How would we build this tool? What components will we build? How will it interact with already existing components that the user uses? (Coding agent, Playwright, etc...)
