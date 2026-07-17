const STORAGE_KEY = "demo-todo-app:todos";

let todos = load();

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
}

function addTodo(text) {
  const todo = { id: Date.now(), text, completed: false };
  todos.push(todo);
  save();
  render();
}

function toggleTodo(id) {
  const todo = todos.find((t) => t.id === id);
  if (todo) {
    todo.completed = !todo.completed;
  }
  render();
}

function deleteTodo(id) {
  todos = todos.filter((t) => t.id !== id);
  save();
  render();
}

function render() {
  const list = document.getElementById("todo-list");
  list.innerHTML = "";

  todos.forEach((todo) => {
    const li = document.createElement("li");
    li.className = "todo-item" + (todo.completed ? " completed" : "");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = todo.completed;
    checkbox.addEventListener("change", () => toggleTodo(todo.id));

    const span = document.createElement("span");
    span.textContent = todo.text;

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => deleteTodo(todo.id));

    li.append(checkbox, span, deleteBtn);
    list.append(li);
  });

  const remaining = todos.filter((t) => !t.completed).length;
  document.getElementById("count").textContent = `${remaining} item${
    remaining === 1 ? "" : "s"
  } left`;
}

const form = document.getElementById("todo-form");
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.getElementById("new-todo");
  const text = input.value.trim();
  if (!text) return;
  addTodo(text);
  input.value = "";
});

render();
