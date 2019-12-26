#
#  responses.ex
#  lib
# 
#  Created by Wess Cope (me@wess.io) on 11/12/19
#  Copyright 2019 Wess Cope
#

defmodule Responses do
  @moduledoc """
  Plug HTTP Response wrappers.
  """

  require Logger
  alias Ecto.Changeset

  defmacro __using__(_) do
    quote do
      import Plug.Conn
      import unquote(__MODULE__)
    end
  end

  @doc """
  Sends a JSON response
  ## Parameters
  - conn: HTTP connection to send response to.
  - status: Atom or number that represents HTTP response code.
  - data: Struct to be encoded to JSON as the response body.
  - opts: Keyword list of options, supports
          - resp_headers: Map or list of 2-tuple response headers
                          to be added to the response
  ## Example
      conn |> json(:ok, %{hello: "World"})
      conn |> json(:ok, %{hello: "World"}, resp_headers: %{"x-foo" => "bar"})
  """
  def json(conn, status, data, opts \\ []) do
    resp_headers = Keyword.get(opts, :resp_headers, [])
    do_json(conn, status, data, resp_headers)
  end
  defp do_json(conn, status, data, resp_headers) do
    conn
    |> Plug.Conn.merge_resp_headers(resp_headers)
    |> Plug.Conn.put_resp_content_type("application/json")
    |> Plug.Conn.send_resp(status, Jason.encode_to_iodata!(data))
    |> Plug.Conn.halt()
  end

  @doc """
  Sends an HTML response
  ## Parameters
  - conn: HTTP connection to send response to.
  - status: Atom or number that represents HTTP response code.
  - data: HTML string set as the response body.
  - opts: Keyword list of options, supports
          - resp_headers: Map or list of 2-tuple response headers
                          to be added to the response
  ## Example
      conn |> html("<h1>Hello World</h1>")
      conn |> html(:ok, "<h1>Hello World</h1>", resp_headers: %{"x-foo" => "bar"})
  """
  def html(conn, status, data, opts \\ []) do
    resp_headers = Keyword.get(opts, :resp_headers, [])
    do_html(conn, status, data, resp_headers)
  end
  defp do_html(conn, status, data, resp_headers) do
    conn
    |> Plug.Conn.merge_resp_headers(resp_headers)
    |> Plug.Conn.put_resp_content_type("text/html")
    |> Plug.Conn.send_resp(status, to_string(data))
    |> Plug.Conn.halt()
  end

  @doc """
  Sends an HTML response
  ## Parameters
  - conn: HTTP connection to send response to.
  - status: Atom or number that represents HTTP response code.
  - data: Text string set as the response body.
  - opts: Keyword list of options, supports
          - resp_headers: Map or list of 2-tuple response headers
                          to be added to the response
  ## Example
      conn |> text(:ok, "Hello World!")
      conn |> text(:ok, "Hello World!", resp_headers: %{"x-foo" => "bar"})
  """
  def text(conn, status, data, opts \\ []) do
    resp_headers = Keyword.get(opts, :resp_headers, [])
    do_text(conn, status, data, resp_headers)
  end
  defp do_text(conn, status, data, resp_headers) do
    conn
    |> Plug.Conn.merge_resp_headers(resp_headers)
    |> Plug.Conn.put_resp_content_type("text/plain")
    |> Plug.Conn.send_resp(status, to_string(data))
    |> Plug.Conn.halt()
  end

  @doc """
  Sends a file respone
  ## Parameters
  - conn: HTTP connection to send response to.
  - status: Atom or number that represents HTTP response code.
  - path: File path for file response.
  - opts: Keyword list of options, supports
          - resp_headers: Map or list of 2-tuple response headers
                          to be added to the response
  ## Example
      conn |> file(:ok, "/path/to/file!")
      conn |> file(:ok, "/path/to/file", resp_headers: %{"x-foo" => "bar"})
  """
  def file(conn, path, opts \\ []) do
    resp_headers = Keyword.get(opts, :resp_headers, [])

    if path |> File.exists? do
      conn
      |> do_file(:ok, path, resp_headers)
    else
      conn
      |> status(:not_found)
    end
    
  end
  defp do_file(conn, status, path, resp_headers) do
    stat = File.stat!(path, time: :posix)

    conn
    |> Plug.Conn.merge_resp_headers(resp_headers)
    |> Plug.Conn.put_resp_content_type(:mimerl.filename(path))
    |> Plug.Conn.put_resp_header("content-length", "#{stat.size}")
    |> Plug.Conn.put_resp_header("content-transfer-encoding", "binary")
    |> Plug.Conn.put_resp_header("cache-control", "must-revalidate, post-check=0, pre-check=0")
    |> Plug.Conn.send_file(status, path)
  end

  def download(conn, path, opts \\ []) do
    resp_headers = Keyword.get(opts, :resp_headers, [])

    if path |> File.exists? do
      conn
      |> do_download(:ok, path, resp_headers)
    else
      conn
      |> status(:not_found)
    end
  end
  defp do_download(conn, status, path, resp_headers) do
    stat = File.stat!(path, time: :posix)

    conn
    |> Plug.Conn.merge_resp_headers(resp_headers)
    |> Plug.Conn.put_resp_header("content-disposition", "attachment; filename=#{Path.basename(path)}")
    |> Plug.Conn.put_resp_content_type(:mimerl.filename(path))
    |> Plug.Conn.put_resp_header("content-length", "#{stat.size}")
    |> Plug.Conn.put_resp_header("content-transfer-encoding", "binary")
    |> Plug.Conn.put_resp_header("cache-control", "must-revalidate, post-check=0, pre-check=0")
    |> Plug.Conn.send_file(status, path)    
  end

  @doc """
  Sends a status _only_ response
  ## Parameters
  - conn:   HTTP connection to send response to.
  - status: Atom or number that represents HTTP response code.
  - opts:   Keyword list of options, supports
            - resp_headers: Map or list of 2-tuple response headers
                            to be added to the response
  ## Example
      conn |> status(:ok)
  """
  def status(conn, status, opts \\ []) do
    resp_headers = Keyword.get(opts, :resp_headers, [])
    do_status(conn, status, resp_headers)
  end
  defp do_status(conn, status, resp_headers) do
    conn
    |> Plug.Conn.merge_resp_headers(resp_headers)
    |> Plug.Conn.send_resp(status, "")
    |> Plug.Conn.halt()
  end

  @doc """
  Redirects request.
  ## Parameters
  - conn: HTTP connection to redirect.
  - status: Atom or number that represents HTTP response code.
  - url:  String representing URL/URI destination.
  ## Example
      conn |> redirect("http://<foo>.com/")
      conn |> redirect(301, "http://<foo>.com/")
  """
  def redirect(conn, status \\ 302, url) do
    conn
    |> Plug.Conn.put_resp_header("location", url)
    |> Plug.Conn.send_resp(status, "")
    |> Plug.Conn.halt()
  end

  def changeset_params(params \\ %{}) do
    params
    |> Enum.reduce(%{}, fn({k,v}, acc) -> Map.put(acc, String.to_atom(k), v) end)
  end

  def parse_errors(changeset = %Ecto.Changeset{}) do
    Changeset.traverse_errors(changeset, fn {msg, opts} ->
      Enum.reduce(opts, msg, fn {key, value}, acc ->
        String.replace(acc, "%{#{key}}", to_string(value))
      end)
    end)
  end

  def parse_errors(errors) when is_binary(errors) do
    %{error: errors}
  end

  def parse_errors(errors) when is_map(errors) do
    errors
  end

  def parse_errors(_errors) do
    %{error: "There was an error processing your request"}
  end

end
