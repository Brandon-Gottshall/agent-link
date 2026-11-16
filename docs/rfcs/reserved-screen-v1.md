# RFC · shared reserved-screen Vercel turns

**Status: OPEN.** Design frozen for implementation. Capability qualification, loaded-host adoption, independent verification, promotion and closure require separate receipts.

The [specification](../specifications/reserved-screen-v1.md) defines the owner outcome. Agent Link MCP servers use one private local broker. GUI Queue operates a separate owner control channel to that broker. The broker owns admission, journal, scope, lease epochs and the contained Vercel process. Vercel is a deterministic actuator. Antechamber retains authenticated browser authority.

- [Protocol and enrollment](reserved-screen-v1/protocol.md)
- [Capability and confinement](reserved-screen-v1/capability.md)
- [Lifecycle, cutover and recovery](reserved-screen-v1/lifecycle.md)
- [Acceptance and independent evidence](reserved-screen-v1/acceptance.md)

Implementation order is specification, RFC, backend, consumer integration, independent verification, reviewed PR and clean-main promotion, then live verification and RFC closure. The rollout uses the finite serial allocation and executor binding authorized in the private Factory record. Publication grants neither capacity nor runtime authority.
