# The Nous sandbox image — where a runtime:sandbox skill executes.
#
# Deliberately minimal for v1: Node + a shell, nothing else, so it stays small
# enough to live on the app box (an alpine base is ~130MB) and starts fast. A
# skill's whole folder is copied to /skill at run time (not baked in), the skill
# runs with its working directory there, and it writes its results to /skill/output.
#
# The producer image (headless Chrome for gtm-visual, Remotion for trailers, fonts)
# is a FAT variant of this file — same contract, more deps — and belongs on a box
# with the RAM/disk to host it, not the app box. This base proves the mechanism.
FROM node:20-alpine

# A non-root user: a sandboxed skill never needs root, and the executor also runs
# the container with --network=none + memory/pid caps. Defence in depth.
RUN addgroup -S skill && adduser -S skill -G skill \
 && mkdir -p /skill/output && chown -R skill:skill /skill

WORKDIR /skill
USER skill

# No ENTRYPOINT: the executor passes the command to run (the skill's entrypoint),
# so one image serves every skill. Idle by default if started with no command.
CMD ["node", "--version"]
