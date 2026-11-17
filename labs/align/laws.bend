# Offset algebra for the alignment lane.
#
# Bend 0.2.38 has no law or proof command. These are executable checks over the
# same dot and lag functions the kernel uses. They guard the model, not the
# generated C or the JavaScript runtime.

def dot(a: List(u24), b: List(u24)) -> u24:
  match a:
    case List/Cons:
      match b:
        case List/Cons:
          return a.head * b.head + dot(a.tail, b.tail)
        case List/Nil:
          return 0
    case List/Nil:
      return 0

def drop(xs: List(u24), n: u24) -> List(u24):
  if n == 0:
    return xs
  else:
    match xs:
      case List/Cons:
        return drop(xs.tail, n - 1)
      case List/Nil:
        return List/Nil

# index - bias is the signed lag. A positive lag drops B's head.
def at(a: List(u24), b: List(u24), index: u24, bias: u24) -> u24:
  if index > bias:
    return dot(a, drop(b, index - bias))
  else:
    if index < bias:
      return dot(drop(a, bias - index), b)
    else:
      return dot(a, b)

def identity_holds() -> u24:
  a = [1, 2, 3, 4, 5]
  if at(a, a, 2, 2) == dot(a, a):
    return 1
  else:
    return 0

def antisymmetry_holds() -> u24:
  a = [1, 2, 3, 4, 5]
  b = [0, 1, 2, 3, 4, 5]
  if at(a, b, 3, 2) == at(b, a, 1, 2):
    return 1
  else:
    return 0

def composition_holds() -> u24:
  a = [1, 2, 3, 4, 5]
  b = [0, 1, 2, 3, 4, 5]
  c = [0, 0, 1, 2, 3, 4, 5]
  if at(a, c, 4, 2) == at(a, b, 3, 2):
    if at(a, c, 4, 2) == at(b, c, 3, 2):
      return 1
    else:
      return 0
  else:
    return 0

def boundedness_holds() -> u24:
  zero = [0, 0, 0, 0]
  if at(zero, zero, 0, 2) == 0:
    if at(zero, zero, 1, 2) == 0:
      if at(zero, zero, 2, 2) == 0:
        if at(zero, zero, 3, 2) == 0:
          return 1
        else:
          return 0
      else:
        return 0
    else:
      return 0
  else:
    return 0
