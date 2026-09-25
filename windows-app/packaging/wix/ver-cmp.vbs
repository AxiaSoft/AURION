On Error Resume Next
Dim prev, cur
prev = Trim(Session.Property("AURION_PREV_VERSION"))
cur = Trim(Session.Property("ProductVersion"))
Dim res : res = "same"
If prev = "" Then
  res = "older"
Else
  Dim pv, cv, i, a, b
  pv = Split(prev & ".0.0.0", ".")
  cv = Split(cur & ".0.0.0", ".")
  For i = 0 To 2
    a = 0 : b = 0
    If IsNumeric(pv(i)) Then a = CInt(pv(i))
    If IsNumeric(cv(i)) Then b = CInt(cv(i))
    If a > b Then res = "newer" : Exit For
    If a < b Then res = "older" : Exit For
  Next
End If
If res = "older" Then Session.Property("AURION_PREV_OLDER") = "1"
If res = "same" Then Session.Property("AURION_PREV_SAME") = "1"
If res = "newer" Then Session.Property("AURION_PREV_NEWER") = "1"
