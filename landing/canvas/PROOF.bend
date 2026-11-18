import Base
import LAWS.bend as Laws

def Laws.depth_of_push(stack, name):
  {==}

def Laws.top_of_push(stack, name):
  {==}

def Laws.empty_depth():
  {==}

def Laws.undo_keeps_peer(marks):
  match marks:
    case Laws.NoMarks{}:
      {==}
    case Laws.Marked{m, rest}:
      match m:
        case Laws.Mine{i}:
          {==}
        case Laws.Peer{i}:
          %Laws.undo_keeps_peer(rest) : {Nat.add(1n, Laws.peerMarks(Laws.undoMark(rest))) == Nat.add(1n, _) : Nat}; {==}

def Laws.undo_takes_mine(id, rest):
  {==}

def Laws.hidden_adds_nothing(alpha, rest):
  {==}

def Laws.shown_adds_alpha(alpha, rest):
  {==}

def Laws.hidden_sheet_is_empty(plate):
  match plate:
    case Laws.NoPlates{}:
      {==}
    case Laws.Plate{on, alpha, rest}:
      Laws.hidden_sheet_is_empty(rest)
