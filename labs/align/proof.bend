# The executable form of the alignment laws.
#
# The installed Bend 0.2.38 CLI has no `bend PROOF.bend` proof mode. Run this
# file with `bend run-c proof.bend`. A 1 means the law held for the model.
from ./laws import (
  identity_holds,
  antisymmetry_holds,
  composition_holds,
  boundedness_holds,
)

def report(name: String, value: u24) -> IO(u24):
  with IO:
    * <- IO/print(name)
    * <- IO/print(u24/to_string(value))
    * <- IO/print("\n")
    return wrap(value)

def main() -> IO(u24):
  with IO:
    * <- report("identity ", identity_holds())
    * <- report("antisymmetry ", antisymmetry_holds())
    * <- report("composition ", composition_holds())
    * <- report("boundedness ", boundedness_holds())
    return wrap(0)
