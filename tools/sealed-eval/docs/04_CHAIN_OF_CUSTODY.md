# Chain of custody

Every material evaluation event should be appended to `chain-of-custody.jsonl`. Each record contains the hash of the previous record, creating a tamper-evident chain.

Recommended events:

- preregistration created;
- corpus frozen;
- question set frozen;
- seal published;
- source frozen;
- build completed;
- brain completed and validated;
- environment captured;
- network isolated;
- sealed inputs mounted;
- seal verified;
- each system/condition started and completed;
- raw output file closed and hashed;
- blinded packet created;
- judgments locked;
- unblinding map revealed;
- reports generated;
- evidence package closed.

A hash chain does not prove that every event description is truthful. It proves later editing is detectable. Independent observation, screen recording when permitted, process/network attestations, and signed statements can provide additional assurance.
