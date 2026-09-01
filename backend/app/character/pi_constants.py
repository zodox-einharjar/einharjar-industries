# Industry job slots per activity bucket: base 1 slot + 1 slot per level of each
# relevant skill (max level 5 each, so max 11 slots). Not documented in the SDE
# this app uses (no dgmTypeAttributes table) — sourced from EVE University/EVE
# Ref, worth a quick sanity check against an in-game character during testing.
MANUFACTURING_SKILLS = [3387, 24625]   # Mass Production, Advanced Mass Production
REACTION_SKILLS = [45748, 45749]       # Mass Reactions, Advanced Mass Reactions
SCIENCE_SKILLS = [3406, 24624]         # Laboratory Operation, Advanced Laboratory Operation

# PI facility storage capacity in m3, keyed by SDE groupID. Flat per structure
# class regardless of racial skin — confirmed via the SDE's invGroups (no
# per-racial-variant groups exist). Not in the SDE sqlite this app uses (no
# dgmTypeAttributes/capacity attribute), so hardcoded here; worth a sanity
# check against an in-game colony during testing.
PI_STORAGE_CAPACITY_M3: dict[int, float] = {
    1027: 500,      # Command Center
    1029: 12_000,   # Storage Facility
    1030: 10_000,   # Launchpad
}
