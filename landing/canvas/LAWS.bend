import Base

# The canvas layer stack, modelled the way the panel builds it: a layer sits on
# the one below, and a new layer goes on top. The laws state the two facts the
# panel depends on, and the sheet keeps them checked.

type Stack is Data:
  Empty{}
  Layer{name: U32, rest: Stack}

def push(name: U32, rest: Stack) -> Stack:
  Layer{name, rest}

def depth(stack: Stack) -> Nat:
  match stack:
    case Empty{}:
      0n
    case Layer{h, t}:
      (1n + depth(t) : Nat)

def top(stack: Stack) -> U32:
  match stack:
    case Empty{}:
      0
    case Layer{h, t}:
      h

# LAW: adding a layer adds exactly one to the count.
law depth_of_push:
  for stack: Stack
  for name: U32
  {depth(push(name, stack)) == Nat.add(1n, depth(stack)) : Nat}

# LAW: the layer just added is the one on top.
law top_of_push:
  for stack: Stack
  for name: U32
  {top(push(name, stack)) == name : U32}

# LAW: an empty sheet has no layers, so a count starts at zero.
law empty_depth:
  {depth(Empty{}) == 0n : Nat}

# The undo stack. A mark names the stroke a person drew, and it remembers who
# drew it, so a page can take back its own work and nobody else's.
type Mark is Data:
  Mine{id: U32}
  Peer{id: U32}

type Marks is Data:
  NoMarks{}
  Marked{mark: Mark, rest: Marks}

# Undo reads from the top. A mark of mine is taken off, and a peer mark that
# reached the stack is stepped over, so the stroke it names stays on the sheet.
def undoMark(marks: Marks) -> Marks:
  match marks:
    case NoMarks{}:
      NoMarks{}
    case Marked{m, rest}:
      match m:
        case Mine{i}:
          rest
        case Peer{i}:
          Marked{m, undoMark(rest)}

def peerMarks(marks: Marks) -> Nat:
  match marks:
    case NoMarks{}:
      0n
    case Marked{m, rest}:
      match m:
        case Mine{i}:
          peerMarks(rest)
        case Peer{i}:
          Nat.add(1n, peerMarks(rest))

# LAW: undo never takes back a peer's stroke.
law undo_keeps_peer:
  for marks: Marks
  {peerMarks(undoMark(marks)) == peerMarks(marks) : Nat}

# LAW: undo takes back the top mark when that mark is mine.
law undo_takes_mine:
  for id: U32
  for rest: Marks
  {peerMarks(undoMark(Marked{Mine{id}, rest})) == peerMarks(rest) : Nat}

# The panel's layer list. A plate is a layer on the sheet: on or off, with an
# opacity in percent. The export draws the plates that are on, at their
# opacity, so weight is the share a plate adds to the finished picture.
type Plate is Data:
  NoPlates{}
  Plate{on: Bool, alpha: Nat, rest: Plate}

def weight(plate: Plate) -> Nat:
  match plate:
    case NoPlates{}:
      0n
    case Plate{on, alpha, rest}:
      match on:
        case True{}:
          Nat.add(alpha, weight(rest))
        case False{}:
          weight(rest)

def hideAll(plate: Plate) -> Plate:
  match plate:
    case NoPlates{}:
      NoPlates{}
    case Plate{on, alpha, rest}:
      Plate{False{}, alpha, hideAll(rest)}

# LAW: a hidden layer adds nothing to the picture.
law hidden_adds_nothing:
  for alpha: Nat
  for rest: Plate
  {weight(Plate{False{}, alpha, rest}) == weight(rest) : Nat}

# LAW: a shown layer adds its own opacity.
law shown_adds_alpha:
  for alpha: Nat
  for rest: Plate
  {weight(Plate{True{}, alpha, rest}) == Nat.add(alpha, weight(rest)) : Nat}

# LAW: a sheet with every layer hidden is empty.
law hidden_sheet_is_empty:
  for plate: Plate
  {weight(hideAll(plate)) == 0n : Nat}
